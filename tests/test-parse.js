const fs = require('fs');
const content = fs.readFileSync('debug-text.txt', 'utf8');

console.log('Total length:', content.length);
console.log('Text around 518 (-50 to +50):');
console.log(content.substring(518 - 50, 518 + 50));
console.log('Text from 400 to 600:');
console.log(content.substring(400, 600));

try {
  JSON.parse(content);
  console.log('JSON parsed OK');
} catch(e) {
  console.log('JSON parse error:', e.message);
}
