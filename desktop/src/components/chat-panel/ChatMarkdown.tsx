import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { visit } from "unist-util-visit";
import type { Content, Link, Root, Text } from "mdast";
import "katex/dist/katex.min.css";

function remarkCitations() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index == null || parent.type === "link") return;
      const value = node.value;
      const regex = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;
      const parts: Content[] = [];
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(value))) {
        if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
        match[1]
          .split(",")
          .map((number) => number.trim())
          .filter(Boolean)
          .forEach((number) => {
            const link: Link = {
              type: "link",
              url: `citation:${number}`,
              children: [{ type: "text", value: `[${number}]` }],
            };
            parts.push(link);
          });
        last = match.index + match[0].length;
      }
      if (!parts.length) return;
      if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
      parent.children.splice(index, 1, ...parts);
      return index + parts.length;
    });
  };
}

export function ChatMarkdown({
  text,
  onCite,
  validCites,
}: {
  text: string;
  onCite: (n: number) => void;
  validCites?: Set<number>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkCitations]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={(url) => (url.startsWith("citation:") ? url : defaultUrlTransform(url))}
      components={{
        a({ href, children, ...props }) {
          if (href?.startsWith("citation:")) {
            const number = Number(href.slice("citation:".length));
            if (validCites && !validCites.has(number)) return <sup>{children}</sup>;
            return (
              <sup>
                <button type="button" className="cite-link" onClick={() => onCite(number)}>
                  {children}
                </button>
              </sup>
            );
          }
          return (
            <a href={href} {...props}>
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
