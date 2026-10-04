/** Free network smoke test: no model call and no credential is needed. */
import { searchWeb } from '../src/web-search.js';
import { fetchSourceText } from '../src/verify.js';

const question = process.argv.slice(2).join(' ').trim() || 'Mithraism Roman Iranian origins';
console.log(`query: ${question}`);
const { results, errors } = await searchWeb(question, { limit: 8 });
for (const error of errors) console.log(`  search limitation: ${error}`);
console.log(`${results.length} leads`);
let readable = 0;
for (const lead of results.slice(0, 4)) {
  if (lead.metadataOnly) {
    console.log(`  catalogue only ${lead.engine}: ${lead.title}`);
    console.log(`    ${lead.url}`);
    continue;
  }
  let page = await fetchSourceText(lead.url);
  if ((!page.ok || page.text.length < 250) && lead.alternateUrl)
    page = await fetchSourceText(lead.alternateUrl);
  if (page.ok && page.text.length >= 250) readable++;
  console.log(`  ${page.ok && page.text.length >= 250 ? 'read' : 'skip'} ${lead.engine}: ${lead.title}`);
  console.log(`    ${lead.url}`);
  if (!page.ok) console.log(`    ${page.error}`);
  else console.log(`    ${page.text.length} characters${page.archived ? ' (archived)' : ''}`);
  if (readable >= 2) break;
}
console.log(`${readable} readable source(s); no model was called`);
if (!readable) process.exitCode = 1;
