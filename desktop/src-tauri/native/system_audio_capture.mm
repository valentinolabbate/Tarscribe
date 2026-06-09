#include <AudioToolbox/ExtendedAudioFile.h>
#include <CoreAudio/AudioHardwareTapping.h>
#include <CoreAudio/CATapDescription.h>
#include <Foundation/Foundation.h>

#include <atomic>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>

namespace {

// Lock-free single-producer/single-consumer ring buffer of mono float samples.
// Producer: the real-time audio IOProc. Consumer: the main-thread poll command.
// Sized for ~5 s at 48 kHz so a stalled consumer drops the oldest samples rather
// than blocking the audio thread.
constexpr size_t kRingCapacity = 1u << 18; // 262144 floats (~1 MB)
constexpr size_t kRingMask = kRingCapacity - 1;

struct CaptureState {
    AudioObjectID tapID = kAudioObjectUnknown;
    AudioObjectID aggregateDeviceID = kAudioObjectUnknown;
    AudioDeviceIOProcID ioProcID = nullptr;
    ExtAudioFileRef file = nullptr;
    AudioStreamBasicDescription format = {};
    AudioStreamBasicDescription fileFormat = {};
    std::atomic<bool> paused = false;

    // Live-preview ring buffer (mono, tap sample rate).
    std::unique_ptr<float[]> ring = std::make_unique<float[]>(kRingCapacity);
    std::atomic<size_t> ringWrite = 0;
    std::atomic<size_t> ringRead = 0;
};

// Push a mono sample into the ring buffer; drop on overflow (audio thread).
inline void ringPush(CaptureState& state, float sample) {
    const size_t write = state.ringWrite.load(std::memory_order_relaxed);
    const size_t next = (write + 1) & kRingMask;
    if (next == state.ringRead.load(std::memory_order_acquire)) {
        return; // full — consumer fell behind, drop the sample
    }
    state.ring[write] = sample;
    state.ringWrite.store(next, std::memory_order_release);
}

// Downmix the tap's float frames to mono and feed the ring buffer for the live
// preview. Only 32-bit float is handled (the format the process tap delivers);
// anything else simply leaves the preview silent without affecting the file.
void pushLivePreview(CaptureState& state, const AudioBufferList* inputData) {
    const AudioStreamBasicDescription& fmt = state.format;
    const bool isFloat = (fmt.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    if (!isFloat || fmt.mBitsPerChannel != 32 || inputData->mNumberBuffers == 0) {
        return;
    }

    if (inputData->mNumberBuffers == 1) {
        // Interleaved: [c0 c1 c0 c1 ...]
        const auto& buffer = inputData->mBuffers[0];
        const UInt32 channels = buffer.mNumberChannels ? buffer.mNumberChannels : 1;
        const auto* data = static_cast<const float*>(buffer.mData);
        if (data == nullptr) {
            return;
        }
        const UInt32 frames = buffer.mDataByteSize / (sizeof(float) * channels);
        for (UInt32 frame = 0; frame < frames; ++frame) {
            float sum = 0.0f;
            for (UInt32 ch = 0; ch < channels; ++ch) {
                sum += data[frame * channels + ch];
            }
            ringPush(state, sum / static_cast<float>(channels));
        }
    } else {
        // Non-interleaved: one buffer per channel.
        const UInt32 channels = inputData->mNumberBuffers;
        const UInt32 frames = inputData->mBuffers[0].mDataByteSize / sizeof(float);
        for (UInt32 frame = 0; frame < frames; ++frame) {
            float sum = 0.0f;
            for (UInt32 ch = 0; ch < channels; ++ch) {
                const auto* data = static_cast<const float*>(inputData->mBuffers[ch].mData);
                if (data != nullptr) {
                    sum += data[frame];
                }
            }
            ringPush(state, sum / static_cast<float>(channels));
        }
    }
}

std::mutex gCaptureMutex;
std::unique_ptr<CaptureState> gCapture;

AudioObjectPropertyAddress propertyAddress(AudioObjectPropertySelector selector) {
    return {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
}

std::string statusMessage(const char* operation, OSStatus status) {
    char fourcc[5] = {};
    const UInt32 value = CFSwapInt32HostToBig(static_cast<UInt32>(status));
    std::memcpy(fourcc, &value, 4);
    for (size_t index = 0; index < 4; ++index) {
        if (!std::isprint(fourcc[index])) {
            fourcc[index] = '?';
        }
    }
    return std::string(operation) + " fehlgeschlagen (" + fourcc + ", " + std::to_string(status) + ")";
}

char* copyError(const std::string& error) {
    return ::strdup(error.c_str());
}

OSStatus audioIOProc(AudioObjectID,
                     const AudioTimeStamp*,
                     const AudioBufferList* inputData,
                     const AudioTimeStamp*,
                     AudioBufferList*,
                     const AudioTimeStamp*,
                     void* clientData) noexcept {
    auto* state = static_cast<CaptureState*>(clientData);
    if (state == nullptr || state->paused.load(std::memory_order_relaxed) || state->file == nullptr ||
        inputData == nullptr || inputData->mNumberBuffers == 0) {
        return kAudioHardwareNoError;
    }

    const auto& buffer = inputData->mBuffers[0];
    if (state->format.mBytesPerFrame == 0) {
        return kAudioHardwareNoError;
    }
    pushLivePreview(*state, inputData);

    const UInt32 frameCount = buffer.mDataByteSize / state->format.mBytesPerFrame;
    return ExtAudioFileWriteAsync(state->file, frameCount, inputData);
}

void cleanUp(CaptureState& state) {
    if (state.ioProcID != nullptr && state.aggregateDeviceID != kAudioObjectUnknown) {
        AudioDeviceStop(state.aggregateDeviceID, state.ioProcID);
        AudioDeviceDestroyIOProcID(state.aggregateDeviceID, state.ioProcID);
        state.ioProcID = nullptr;
    }
    if (state.file != nullptr) {
        ExtAudioFileDispose(state.file);
        state.file = nullptr;
    }
    if (state.aggregateDeviceID != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(state.aggregateDeviceID);
        state.aggregateDeviceID = kAudioObjectUnknown;
    }
    if (state.tapID != kAudioObjectUnknown) {
        if (@available(macOS 14.2, *)) {
            AudioHardwareDestroyProcessTap(state.tapID);
        }
        state.tapID = kAudioObjectUnknown;
    }
}

std::string startCapture(const char* outputPath) {
    if (outputPath == nullptr || outputPath[0] == '\0') {
        return "Kein Zielpfad für die Systemaudio-Aufnahme angegeben.";
    }
    if (gCapture) {
        return "Es läuft bereits eine Systemaudio-Aufnahme.";
    }
    if (@available(macOS 14.2, *)) {
        auto state = std::make_unique<CaptureState>();

        CATapDescription* description =
            [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
        description.name = @"Tarscribe System Audio";
        description.privateTap = YES;
        description.muteBehavior = CATapUnmuted;

        OSStatus status = AudioHardwareCreateProcessTap(description, &state->tapID);
        if (status != kAudioHardwareNoError) {
            return statusMessage("Systemaudio-Tap", status);
        }

        auto tapUIDAddress = propertyAddress(kAudioTapPropertyUID);
        UInt32 propertySize = sizeof(CFStringRef);
        CFStringRef tapUID = nullptr;
        status = AudioObjectGetPropertyData(state->tapID, &tapUIDAddress, 0, nullptr, &propertySize, &tapUID);
        if (status != kAudioHardwareNoError || tapUID == nullptr) {
            cleanUp(*state);
            return statusMessage("Tap-ID", status);
        }

        NSDictionary* aggregateDescription = @{
            [NSString stringWithUTF8String:kAudioAggregateDeviceNameKey] : @"Tarscribe System Audio",
            [NSString stringWithUTF8String:kAudioAggregateDeviceUIDKey] : NSUUID.UUID.UUIDString,
            [NSString stringWithUTF8String:kAudioAggregateDeviceIsPrivateKey] : @YES,
        };
        status = AudioHardwareCreateAggregateDevice(
            (__bridge CFDictionaryRef)aggregateDescription, &state->aggregateDeviceID);
        if (status != kAudioHardwareNoError) {
            CFRelease(tapUID);
            cleanUp(*state);
            return statusMessage("Virtuelles Audiogerät", status);
        }

        CFArrayRef tapList =
            CFArrayCreate(kCFAllocatorDefault, reinterpret_cast<const void**>(&tapUID), 1, &kCFTypeArrayCallBacks);
        auto tapListAddress = propertyAddress(kAudioAggregateDevicePropertyTapList);
        propertySize = sizeof(CFArrayRef);
        status = AudioObjectSetPropertyData(
            state->aggregateDeviceID, &tapListAddress, 0, nullptr, propertySize, &tapList);
        CFRelease(tapList);
        CFRelease(tapUID);
        if (status != kAudioHardwareNoError) {
            cleanUp(*state);
            return statusMessage("Systemaudio-Tap-Verknüpfung", status);
        }

        auto formatAddress = propertyAddress(kAudioTapPropertyFormat);
        propertySize = sizeof(AudioStreamBasicDescription);
        status = AudioObjectGetPropertyData(
            state->tapID, &formatAddress, 0, nullptr, &propertySize, &state->format);
        if (status != kAudioHardwareNoError) {
            cleanUp(*state);
            return statusMessage("Systemaudio-Format", status);
        }

        state->fileFormat = state->format;
        state->fileFormat.mFormatID = kAudioFormatLinearPCM;
        state->fileFormat.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
        state->fileFormat.mBitsPerChannel = 16;
        state->fileFormat.mFramesPerPacket = 1;
        state->fileFormat.mBytesPerFrame =
            state->fileFormat.mChannelsPerFrame * (state->fileFormat.mBitsPerChannel / 8);
        state->fileFormat.mBytesPerPacket =
            state->fileFormat.mBytesPerFrame * state->fileFormat.mFramesPerPacket;

        NSURL* outputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:outputPath]];
        status = ExtAudioFileCreateWithURL(
            (__bridge CFURLRef)outputURL,
            kAudioFileCAFType,
            &state->fileFormat,
            nullptr,
            kAudioFileFlags_EraseFile,
            &state->file);
        if (status != noErr) {
            cleanUp(*state);
            return statusMessage("Aufnahmedatei", status);
        }

        status = ExtAudioFileSetProperty(
            state->file,
            kExtAudioFileProperty_ClientDataFormat,
            sizeof(AudioStreamBasicDescription),
            &state->format);
        if (status != noErr) {
            cleanUp(*state);
            return statusMessage("Aufnahmeformat", status);
        }

        status = AudioDeviceCreateIOProcID(
            state->aggregateDeviceID, audioIOProc, state.get(), &state->ioProcID);
        if (status != kAudioHardwareNoError) {
            cleanUp(*state);
            return statusMessage("Audio-Callback", status);
        }
        status = AudioDeviceStart(state->aggregateDeviceID, state->ioProcID);
        if (status != kAudioHardwareNoError) {
            cleanUp(*state);
            return statusMessage("Systemaudio-Aufnahme", status);
        }

        gCapture = std::move(state);
        return {};
    }
    return "Systemaudio-Aufnahmen benötigen macOS 14.2 oder neuer.";
}

} // namespace

extern "C" char* tarscribe_system_audio_start(const char* outputPath) {
    @autoreleasepool {
        std::lock_guard<std::mutex> guard(gCaptureMutex);
        const auto error = startCapture(outputPath);
        return error.empty() ? nullptr : copyError(error);
    }
}

extern "C" void tarscribe_system_audio_set_paused(bool paused) {
    std::lock_guard<std::mutex> guard(gCaptureMutex);
    if (gCapture) {
        gCapture->paused.store(paused, std::memory_order_relaxed);
    }
}

extern "C" void tarscribe_system_audio_stop() {
    std::lock_guard<std::mutex> guard(gCaptureMutex);
    if (gCapture) {
        cleanUp(*gCapture);
        gCapture.reset();
    }
}

extern "C" void tarscribe_system_audio_free_string(char* value) {
    std::free(value);
}

// Sample rate of the live-preview mono stream (0 if no capture is running).
extern "C" double tarscribe_system_audio_sample_rate() {
    std::lock_guard<std::mutex> guard(gCaptureMutex);
    return gCapture ? gCapture->format.mSampleRate : 0.0;
}

// Drain up to maxSamples mono float samples from the ring buffer into out.
// Returns the number of samples written.
extern "C" int tarscribe_system_audio_poll(float* out, int maxSamples) {
    if (out == nullptr || maxSamples <= 0) {
        return 0;
    }
    std::lock_guard<std::mutex> guard(gCaptureMutex);
    if (!gCapture) {
        return 0;
    }
    CaptureState& state = *gCapture;
    size_t read = state.ringRead.load(std::memory_order_relaxed);
    const size_t write = state.ringWrite.load(std::memory_order_acquire);
    int count = 0;
    while (read != write && count < maxSamples) {
        out[count++] = state.ring[read];
        read = (read + 1) & kRingMask;
    }
    state.ringRead.store(read, std::memory_order_release);
    return count;
}
