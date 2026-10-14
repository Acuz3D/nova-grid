// Claude runs this as each pane's status line. It saves what Claude passes in
// (model, usage limits) to a file the app watches, then prints a short line.
const fs = require('fs');

const outFile = process.argv[2];
let input = '';

process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let data = {};
  try {
    data = JSON.parse(input);
  } catch {}

  try {
    fs.writeFileSync(outFile, JSON.stringify({ at: Date.now(), ...data }));
  } catch {}

  process.stdout.write(data.model?.display_name || '');
});
