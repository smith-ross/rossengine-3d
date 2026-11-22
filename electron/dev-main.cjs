// `npm run player -- --game=path/to/game.json` runs the built runtime (player-build/app) without packaging.
const path = require('node:path')
const appDir = path.join(__dirname, '..', 'player-build', 'app')
process.chdir(appDir)
require(path.join(appDir, 'main.cjs'))
