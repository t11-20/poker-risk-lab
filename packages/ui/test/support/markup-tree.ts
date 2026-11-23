/**
 * Rendered markup as a tree of elements, enough for a test to ask what an element sits inside.
 * React's static markup is well formed, so a tag stack is all the parsing it needs. Not a DOM.
 */

const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);

export interface MarkupElement {
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly parentElement: MarkupElement | null;
  readonly children: MarkupElement[];
  /** The markup between the open and close tags. */
  inner: string;
  hasAttribute(name: string): boolean;
}

export function markupTree(markup: string): MarkupElement {
  const make = (
    tag: string,
    attributes: Map<string, string>,
    parent: MarkupElement | null,
  ): MarkupElement => ({
    tag,
    attributes,
    parentElement: parent,
    children: [],
    inner: '',
    hasAttribute: (name) => attributes.has(name),
  });
  const root = make('#root', new Map(), null);
  const open: { element: MarkupElement; start: number }[] = [{ element: root, start: 0 }];
  for (const match of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/gu)) {
    const [whole, closing, tag = '', rest = ''] = match;
    const at = match.index ?? 0;
    if (closing === '/') {
      const top = open.pop();
      if (top === undefined || top.element.tag !== tag) throw new Error(`unbalanced </${tag}> at ${at}`);
      top.element.inner = markup.slice(top.start, at);
      continue;
    }
    const attributes = new Map<string, string>();
    for (const attribute of rest.matchAll(/([\w:-]+)(?:="([^"]*)")?/gu)) {
      attributes.set(attribute[1] ?? '', attribute[2] ?? '');
    }
    const parent = open.at(-1)?.element ?? root;
    const element = make(tag, attributes, parent);
    parent.children.push(element);
    if (!VOID.has(tag) && !rest.endsWith('/')) open.push({ element, start: at + whole.length });
  }
  root.inner = markup;
  return root;
}

export function findAll(root: MarkupElement, test: (element: MarkupElement) => boolean): MarkupElement[] {
  const found: MarkupElement[] = [];
  const walk = (element: MarkupElement): void => {
    if (test(element)) found.push(element);
    for (const child of element.children) walk(child);
  };
  walk(root);
  return found;
}

export const hasClass = (element: MarkupElement, name: string): boolean =>
  (element.attributes.get('class') ?? '').split(/\s+/u).includes(name);
