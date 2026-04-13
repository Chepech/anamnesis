export interface Chunk {
  text: string;
  heading: string;
  chunkIndex: number;
}

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 64;

/**
 * Simple recursive character text splitter.
 * Splits on paragraph breaks first, then newlines, then spaces.
 * Preserves heading context for each chunk.
 */
export function splitMarkdown(
  content: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentHeading = "";
  const lines = content.split("\n");

  // Walk lines to track the current heading for context
  const blocks: { heading: string; text: string }[] = [];
  let buffer: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      if (buffer.length > 0) {
        blocks.push({ heading: currentHeading, text: buffer.join("\n") });
        buffer = [];
      }
      currentHeading = headingMatch[1].trim();
    }
    buffer.push(line);
  }
  if (buffer.length > 0) {
    blocks.push({ heading: currentHeading, text: buffer.join("\n") });
  }

  let chunkIndex = 0;
  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;

    if (text.length <= chunkSize) {
      chunks.push({ text, heading: block.heading, chunkIndex: chunkIndex++ });
    } else {
      // Split large blocks by sentence/paragraph boundaries
      const subChunks = splitText(text, chunkSize, overlap);
      for (const sub of subChunks) {
        chunks.push({ text: sub, heading: block.heading, chunkIndex: chunkIndex++ });
      }
    }
  }

  return chunks;
}

function splitText(text: string, chunkSize: number, overlap: number): string[] {
  const separators = ["\n\n", "\n", ". ", " "];
  return recursiveSplit(text, separators, chunkSize, overlap);
}

function recursiveSplit(
  text: string,
  separators: string[],
  chunkSize: number,
  overlap: number
): string[] {
  if (text.length <= chunkSize) return [text];
  if (separators.length === 0) {
    // Hard split by character count
    const result: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
      result.push(text.slice(i, i + chunkSize));
    }
    return result;
  }

  const [sep, ...rest] = separators;
  const parts = text.split(sep);

  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length <= chunkSize) {
      current = candidate;
    } else {
      if (current) chunks.push(current.trim());
      // If the part itself is too large, recurse with finer separators
      if (part.length > chunkSize) {
        chunks.push(...recursiveSplit(part, rest, chunkSize, overlap));
        current = "";
      } else {
        current = part;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}
