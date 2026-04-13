import crypto from 'crypto';

export function genKey() {
  return crypto.randomBytes(6).toString('hex');
}

export function heading(text, style = 'h2') {
  return {
    _type: 'block',
    _key: genKey(),
    style,
    markDefs: [],
    children: [{ _type: 'span', _key: genKey(), text, marks: [] }],
  };
}

export function paragraph(text) {
  return {
    _type: 'block',
    _key: genKey(),
    style: 'normal',
    markDefs: [],
    children: [{ _type: 'span', _key: genKey(), text, marks: [] }],
  };
}

export function bulletItem(text, level = 1) {
  return {
    _type: 'block',
    _key: genKey(),
    style: 'normal',
    listItem: 'bullet',
    level,
    markDefs: [],
    children: [{ _type: 'span', _key: genKey(), text, marks: [] }],
  };
}

export function linkedParagraph(segments) {
  // segments: [{ text, href? }]
  const markDefs = [];
  const children = segments.map(seg => {
    if (seg.href) {
      const markKey = genKey();
      markDefs.push({ _type: 'link', _key: markKey, href: seg.href });
      return { _type: 'span', _key: genKey(), text: seg.text, marks: [markKey] };
    }
    return { _type: 'span', _key: genKey(), text: seg.text, marks: [] };
  });
  return {
    _type: 'block',
    _key: genKey(),
    style: 'normal',
    markDefs,
    children,
  };
}

export function callout(label, text, variant = 'teal') {
  return {
    _type: 'callout',
    _key: genKey(),
    label,
    text,
    variant,
  };
}

/**
 * Convert a Portable Text array back to a simple markdown string.
 * Handles blocks, headings, lists, and callouts. Falls through gracefully
 * if the input is already a string.
 */
/**
 * Parse a simple markdown string into Portable Text blocks.
 * Handles: ## headings, paragraphs, **bold**, [links](url)
 */
export function markdownToPortableText(markdown) {
  if (typeof markdown !== 'string') {
    if (Array.isArray(markdown)) return markdown; // already Portable Text
    markdown = String(markdown || '');
  }
  const lines = markdown.split('\n');
  const blocks = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Headings
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push(heading(headingMatch[2], `h${headingMatch[1].length}`));
      continue;
    }

    // Regular paragraph — parse inline formatting
    const children = [];
    const markDefs = [];

    const parts = trimmed.split(/(\[.*?\]\(.*?\)|\*\*.*?\*\*)/g);
    for (const part of parts) {
      if (!part) continue;

      const linkMatch = part.match(/^\[(.*?)\]\((.*?)\)$/);
      if (linkMatch) {
        const key = genKey();
        children.push({ _type: 'span', _key: genKey(), text: linkMatch[1], marks: [key] });
        markDefs.push({ _type: 'link', _key: key, href: linkMatch[2] });
        continue;
      }

      const boldMatch = part.match(/^\*\*(.*?)\*\*$/);
      if (boldMatch) {
        children.push({ _type: 'span', _key: genKey(), text: boldMatch[1], marks: ['strong'] });
        continue;
      }

      children.push({ _type: 'span', _key: genKey(), text: part, marks: [] });
    }

    blocks.push({
      _type: 'block',
      _key: genKey(),
      style: 'normal',
      children: children.length ? children : [{ _type: 'span', _key: genKey(), text: trimmed, marks: [] }],
      markDefs,
    });
  }

  return blocks;
}

export function portableTextToMarkdown(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return String(blocks || '');
  return blocks
    .map((block) => {
      if (block._type === 'block') {
        const text = (block.children || []).map((c) => c.text || '').join('');
        if (block.style === 'h1') return `# ${text}`;
        if (block.style === 'h2') return `## ${text}`;
        if (block.style === 'h3') return `### ${text}`;
        if (block.style === 'h4') return `#### ${text}`;
        if (block.listItem === 'bullet') return `- ${text}`;
        if (block.listItem === 'number') return `1. ${text}`;
        return text;
      }
      if (block._type === 'callout') {
        return `> **${block.label || 'Note'}**: ${block.text || ''}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}
