const fs = require('fs');
const path = require('path');
const subsetFont = require('subset-font');

const srcDir = path.resolve(__dirname, '../src');
const inputFont = path.resolve(__dirname, '../assets/font/MiSans-Medium.woff');
const outputFont = path.resolve(
  __dirname,
  '../public/assets/font/MiSans-Medium.woff2'
);

const textExtensions = ['.vue', '.ts', '.js', '.json', '.html'];

function collectText(dir) {
  let chars = new Set();

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (textExtensions.some(ext => entry.name.endsWith(ext))) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        for (const char of content) {
          chars.add(char);
        }
      }
    }
  }

  walk(dir);
  return [...chars].join('');
}

async function main() {
  if (!fs.existsSync(inputFont)) {
    console.error(`Font not found: ${inputFont}`);
    process.exit(1);
  }

  if (
    fs.existsSync(outputFont) &&
    fs.statSync(outputFont).mtimeMs > fs.statSync(inputFont).mtimeMs
  ) {
    console.log('Subset font is up-to-date, skipping');
    return;
  }

  console.log('Collecting text from source files...');
  const sourceText = collectText(srcDir);

  // Always include ASCII printable and common punctuation / CJK symbols to be safe
  const ascii = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const punctuation =
    ' .,;:!?-—–/\\()[]{}<>"\'‘’“”«»@#$%&*+=_|~`·•…©®™°′″';
  const cjkPunctuation =
    '，。、；：！？（）【】「」『』《》“”‘’—…·￥'; // common CJK punctuation

  const allText = Array.from(
    new Set(sourceText + ascii + punctuation + cjkPunctuation)
  ).join('');

  console.log(`Collected ${allText.length} unique characters`);

  const fontBuffer = fs.readFileSync(inputFont);
  const subsetBuffer = await subsetFont(fontBuffer, allText, {
    targetFormat: 'woff2',
  });

  fs.mkdirSync(path.dirname(outputFont), { recursive: true });
  fs.writeFileSync(outputFont, subsetBuffer);

  const inputSize = fs.statSync(inputFont).size;
  const outputSize = fs.statSync(outputFont).size;
  const reduction = ((1 - outputSize / inputSize) * 100).toFixed(1);

  console.log(`Input:  ${(inputSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Output: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Reduced by ${reduction}%`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
