/** Versioned, dependency-free starting points. The code is saved verbatim in the workflow revision. */
export const WORKFLOW_SCRIPT_TEMPLATES = Object.freeze({
  node: Object.freeze({
    id: 'node-json',
    version: 1,
    runtime: 'node',
    dependencies: [],
    code: "const fs = require('node:fs');\nconst input = JSON.parse(fs.readFileSync(0, 'utf8'));\nconst result = { text: String(input.text ?? '').trim() };\nprocess.stdout.write(JSON.stringify(result));\n",
  }),
  python: Object.freeze({
    id: 'python-json',
    version: 1,
    runtime: 'python',
    dependencies: [],
    code: "import json, sys\ninput_data = json.load(sys.stdin)\nresult = {'text': str(input_data.get('text', '')).strip()}\njson.dump(result, sys.stdout, ensure_ascii=False)\n",
  }),
})
