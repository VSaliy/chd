/** Tiny DOM-free XML parser, sufficient for DASH MPDs. */
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });

export function parseXml(src: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1] as XNode;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      const are = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a: RegExpExecArray | null;
      while ((a = are.exec(m[4] ?? ""))) attrs[(a[1] as string).replace(/^.*:/, "")] = decode(a[2] ?? a[3] ?? "");
      const node: XNode = { name: m[3].replace(/^.*:/, ""), attrs, children: [], text: "" };
      top.children.push(node);
      if (m[5] !== "/") stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  const el = root.children[0];
  if (!el) throw new Error("Invalid XML: no root element");
  return el;
}

export const child = (n: XNode, name: string) => n.children.find((c) => c.name === name);
export const childrenOf = (n: XNode, name: string) => n.children.filter((c) => c.name === name);
