import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const PAGE_WIDTH = 794;
const PAGE_HEIGHT = 1123;
const BODY_WIDTH = 658;
const BODY_HEIGHT = 950;

function documentParts(content: string, fallbackTitle: string) {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { title: fallbackTitle, meta: "", body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { title: fallbackTitle, meta: "", body: normalized };
  const frontmatter = normalized.slice(4, end);
  const value = (key: string) => {
    const match = new RegExp(`^${key}:\\s*["']?(.+?)["']?$`, "m").exec(frontmatter);
    return match?.[1]?.trim() ?? "";
  };
  const title = value("title") || fallbackTitle;
  const meta = [value("date"), value("duration"), value("topic_area")]
    .filter(Boolean)
    .join(" · ");
  return { title, meta, body: normalized.slice(end + 5) };
}

function createMeasurePage(): HTMLDivElement {
  const page = document.createElement("div");
  page.className = "summary-a4-content markdown summary-a4-measure-page";
  page.style.width = `${BODY_WIDTH}px`;
  page.style.height = `${BODY_HEIGHT}px`;
  document.body.appendChild(page);
  return page;
}

function paginate(source: HTMLElement): string[] {
  const pages: string[] = [];
  let page = createMeasurePage();

  const finishPage = () => {
    pages.push(page.innerHTML);
    page.remove();
    page = createMeasurePage();
  };

  const fits = () => page.scrollHeight <= BODY_HEIGHT + 1;

  const appendLongText = (block: HTMLElement) => {
    const words = (block.textContent ?? "").split(/\s+/).filter(Boolean);
    let fragment = block.cloneNode(false) as HTMLElement;
    page.appendChild(fragment);
    for (const word of words) {
      const previous = fragment.textContent ?? "";
      fragment.textContent = previous ? `${previous} ${word}` : word;
      if (fits()) continue;
      fragment.textContent = previous;
      if (previous) {
        finishPage();
      } else {
        fragment.remove();
        if (page.children.length > 0) finishPage();
      }
      fragment = block.cloneNode(false) as HTMLElement;
      fragment.textContent = word;
      page.appendChild(fragment);
    }
  };

  const appendList = (block: HTMLElement) => {
    let list = block.cloneNode(false) as HTMLElement;
    page.appendChild(list);
    for (const child of Array.from(block.children)) {
      const item = child.cloneNode(true) as HTMLElement;
      list.appendChild(item);
      if (fits()) continue;
      item.remove();
      if (list.children.length > 0) {
        finishPage();
      } else {
        list.remove();
        if (page.children.length > 0) finishPage();
      }
      list = block.cloneNode(false) as HTMLElement;
      list.appendChild(item);
      page.appendChild(list);
    }
  };

  const contentProbeFor = (block: Element) => {
    const probe = block.cloneNode(true) as HTMLElement;
    if (block.tagName === "P" || block.tagName === "BLOCKQUOTE") {
      probe.textContent = (block.textContent ?? "").split(/\s+/).slice(0, 24).join(" ");
    } else if (block.tagName === "UL" || block.tagName === "OL") {
      Array.from(probe.children).slice(1).forEach((child) => child.remove());
    }
    return probe;
  };

  const children = Array.from(source.children);
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    const nextChild = children[childIndex + 1];
    if (/^H[1-6]$/.test(child.tagName) && nextChild && page.children.length > 0) {
      const headingProbe = child.cloneNode(true) as HTMLElement;
      const contentProbe = contentProbeFor(nextChild);
      page.append(headingProbe, contentProbe);
      const pairFits = fits();
      headingProbe.remove();
      contentProbe.remove();
      if (!pairFits) finishPage();
    }
    const block = child.cloneNode(true) as HTMLElement;
    page.appendChild(block);
    if (fits()) continue;
    block.remove();
    if (block.tagName === "P") {
      appendLongText(block);
      continue;
    }
    if (block.tagName === "UL" || block.tagName === "OL") {
      appendList(block);
      continue;
    }
    if (page.children.length > 0) finishPage();
    page.appendChild(block);
    if (fits()) continue;
    block.remove();
    if (block.tagName === "UL" || block.tagName === "OL") appendList(block);
    else appendLongText(block);
  }
  if (page.children.length > 0 || pages.length === 0) pages.push(page.innerHTML);
  page.remove();
  return pages;
}

export function A4Preview({ content, title }: { content: string; title: string }) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[]>([""]);
  const [zoom, setZoom] = useState<"fit" | "75" | "100">("fit");
  const [fitScale, setFitScale] = useState(0.7);
  const document = useMemo(() => documentParts(content, title), [content, title]);

  useEffect(() => {
    const source = sourceRef.current;
    if (!source) return;
    const frame = requestAnimationFrame(() => setPages(paginate(source)));
    return () => cancelAnimationFrame(frame);
  }, [document]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setFitScale(Math.min(1, Math.max(0.35, (viewport.clientWidth - 40) / PAGE_WIDTH)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const scale = zoom === "fit" ? fitScale : zoom === "75" ? 0.75 : 1;

  return (
    <div className="summary-a4-preview">
      <div className="summary-a4-toolbar">
        <span>{pages.length} {pages.length === 1 ? "Seite" : "Seiten"}</span>
        <label>
          Ansicht
          <select value={zoom} onChange={(event) => setZoom(event.target.value as typeof zoom)}>
            <option value="fit">Einpassen</option>
            <option value="75">75 %</option>
            <option value="100">100 %</option>
          </select>
        </label>
      </div>
      <div ref={viewportRef} className="summary-a4-viewport">
        {pages.map((html, index) => (
          <div
            className="summary-a4-page-shell"
            key={`${index}-${pages.length}`}
            style={{ width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale }}
          >
            <article
              className="summary-a4-page"
              style={{ transform: `scale(${scale})` }}
            >
              <div
                className="summary-a4-page-body summary-a4-content markdown"
                dangerouslySetInnerHTML={{ __html: html }}
              />
              <footer>
                <span>{title}</span>
                <span>Seite {index + 1}</span>
              </footer>
            </article>
          </div>
        ))}
      </div>
      <div ref={sourceRef} className="summary-a4-source summary-a4-content markdown">
        <h1 className="summary-a4-document-title">{document.title}</h1>
        {document.meta && <p className="summary-a4-document-meta">{document.meta}</p>}
        <hr />
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
          {document.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}
