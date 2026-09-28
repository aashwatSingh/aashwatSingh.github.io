// Builds hamza/demo/index.html: a standalone Insights demo on sample data.
// It inlines hamza/insights.js so the demo always runs the real calculations.
// Usage: node scripts/build_demo.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../hamza/', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const insights = read('insights.js').replace(/^export /gm, '');
const template = read('demo/template.html').replace('/*INSIGHTS*/', () => insights);

// The template is `<title>` + `<style>` followed by body markup.
const split = template.indexOf('</style>') + '</style>'.length;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
${template.slice(0, split)}
</head>
<body>
${template.slice(split)}
</body>
</html>
`;
writeFileSync(new URL('demo/index.html', root), html);
console.log(`wrote hamza/demo/index.html (${html.length} bytes)`);
