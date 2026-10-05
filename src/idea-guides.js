/** Curated, editable review lenses for the idea-to-spec handoff. */
import fs from 'node:fs';

export function ideaGuides() {
  return ['product', 'security', 'experience'].map((name) =>
    fs.readFileSync(new URL(`../docs/idea-guides/${name}.md`, import.meta.url), 'utf8').trim())
    .join('\n\n');
}
