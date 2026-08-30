# 2048 web game

Build a polished, offline 2048 game in this workspace. It must run with `npm start`, pass `npm test`, and use only browser and Node.js standard APIs. Do not add dependencies or modify this README, `package.json`, `scripts/`, or `test/`.

## Files to create

- `index.html`
- `styles.css`
- `src/game.js`: pure game engine
- `src/app.js`: browser rendering and input

## Engine contract

`src/game.js` is a native ES module and exports:

- `SIZE`, equal to `4`.
- `slideAndMerge(line)`, returning `{ line, scoreGained }`.
- `moveBoard(board, direction)`, returning `{ board, scoreGained, moved }` for `left`, `right`, `up`, or `down`.
- `addRandomTile(board, random = Math.random)`, returning a new board.
- `hasAvailableMoves(board)`.
- `createGame(random = Math.random)`, returning `{ board, score, status }`.
- `move(state, direction, random = Math.random)`, returning `{ board, score, status, moved }`.

A board is a 4×4 matrix of non-negative numbers. Engine functions must not mutate their inputs. A tile may merge only once per move. The score increases by the value of each merged tile.

When empty cells exist, `addRandomTile` calls `random` exactly twice. The first result chooses an empty cell from a row-major list with `Math.floor(random() * emptyCells.length)`. The second produces `2` below `0.9`, otherwise `4`. A full board does not call `random`. `createGame` adds two tiles.

`move` adds one random tile only after a board-changing move and accumulates the score. Its status is `won` when a tile reaches 2048, `lost` when no move remains, and `playing` otherwise. An unchanged move must not consume randomness.

## Browser experience

Render a responsive 4×4 board with distinct tile values and clear score, best score, game status, and New Game control. Persist the best score in `localStorage`. Support arrow keys and WASD, plus touch or pointer swipes. Prevent handled keys from scrolling the page. Give controls accessible labels and announce score/status changes without requiring a mouse.

Use a cohesive visual design that remains usable on a narrow phone viewport. Do not load fonts, scripts, images, or styles from the network.
