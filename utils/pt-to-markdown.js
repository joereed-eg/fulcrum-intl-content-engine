/**
 * Convert Sanity Portable Text to clean Markdown.
 * Handles markDefs-based bold/italic/links (Sanity's format)
 * as well as inline decorator marks.
 */

function escapeMarkdown(text) {
  // Only escape characters that would break markdown structure
  return text.replace(/([\\`])/g, '\\$1');
}

function renderSpan(child, markDefs) {
  let text = child.text || '';
  if (!text) return '';

  const marks = child.marks || [];
  let hasLink = false;
  let linkUrl = '';
  let isBold = false;
  let isItalic = false;
  let isCode = false;

  for (const markKey of marks) {
    // Check if it's a decorator mark
    if (markKey === 'strong') { isBold = true; continue; }
    if (markKey === 'em') { isItalic = true; continue; }
    if (markKey === 'code') { isCode = true; continue; }

    // Check markDefs for link/strong/em defined as markDefs
    const markDef = (markDefs || []).find(m => m._key === markKey);
    if (!markDef) continue;

    if (markDef._type === 'link' && markDef.href) {
      hasLink = true;
      linkUrl = markDef.href;
    } else if (markDef._type === 'strong') {
      isBold = true;
    } else if (markDef._type === 'em') {
      isItalic = true;
    }
  }

  // Apply formatting (code first, then bold/italic, then link)
  if (isCode) text = `\`${text}\``;
  if (isBold) text = `**${text.trim()}** `;
  if (isItalic) text = `*${text.trim()}* `;
  if (hasLink) text = `[${text.trim()}](${linkUrl})`;

  return text;
}

export function portableTextToMarkdown(body) {
  if (!body || !Array.isArray(body)) return '';

  const lines = [];
  let inList = null;

  for (let i = 0; i < body.length; i++) {
    const block = body[i];

    if (block._type !== 'block') continue;

    const children = (block.children || []).map(c => renderSpan(c, block.markDefs)).join('');
    const text = children.trim();
    if (!text) continue;

    const style = block.style || 'normal';
    const listItem = block.listItem;

    // Close list if we're leaving one
    if (!listItem && inList) {
      lines.push('');
      inList = null;
    }

    if (listItem) {
      if (!inList) lines.push(''); // blank line before list starts
      inList = listItem;
      const prefix = listItem === 'number' ? '1.' : '-';
      lines.push(`${prefix} ${text}`);
    } else if (style === 'h1') {
      lines.push('', `# ${text}`, '');
    } else if (style === 'h2') {
      lines.push('', `## ${text}`, '');
    } else if (style === 'h3') {
      lines.push('', `### ${text}`, '');
    } else if (style === 'h4') {
      lines.push('', `#### ${text}`, '');
    } else if (style === 'blockquote') {
      lines.push('', `> ${text}`, '');
    } else {
      lines.push('', text);
    }
  }

  // Clean up: remove multiple blank lines
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
