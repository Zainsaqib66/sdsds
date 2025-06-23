// server.js
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const usersFile = path.join(__dirname, "user.json");
const activeUsers = new Set();

// --- Session setup ---
const sessionMiddleware = session({
  secret: "your-strong-secret",      // change this!
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});
app.use(express.json());
app.use(sessionMiddleware);

// share sessions with socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// --- User registration/login/logout ---
function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(usersFile));
  } catch {
    return [];
  }
}
function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

app.post("/api/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username & password required" });
  }
  const users = readUsers();
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: "Username already taken" });
  }
  users.push({ username, password });
  writeUsers(users);
  res.json({ success: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) {
    return res.status(400).json({ error: "Invalid credentials" });
  }
  if (activeUsers.has(username)) {
    return res.status(400).json({ error: "This account is already logged in" });
  }
  req.session.username = username;
  activeUsers.add(username);
  res.json({ success: true, username });
});

app.post("/api/logout", (req, res) => {
  if (req.session.username) {
    activeUsers.delete(req.session.username);
    req.session.destroy(() => res.json({ success: true }));
  } else {
    res.json({ success: true });
  }
});

// serve client
app.use(express.static(path.join(__dirname, "public")));

// --- Game logic ---
const WAIT_TIMEOUT = 20000;
const waiting = { "3": null, "4": null };
const rooms = {};

function roomId(a, b, grid) {
  return [a, b, grid].sort().join("-");
}

io.use((socket, next) => {
  const req = socket.request;
  if (req.session && req.session.username) {
    return next();
  }
  next(new Error("unauthorized"));
});

io.on("connection", socket => {
  let waitTimer;

  socket.on("joinGame", ({ grid }) => {
    grid = String(grid);

    if (waiting[grid] && waiting[grid].id !== socket.id) {
      const other = waiting[grid];
      waiting[grid] = null;
      clearTimeout(waitTimer);

      const room = roomId(socket.id, other.id, grid);
      socket.join(room);
      other.join(room);

      rooms[room] = {
        grid: +grid,
        board: Array(+grid * +grid).fill(null),
        turn: 0,
        gameOver: false,
        rematchReq: {},
        players: [other, socket]  // [X, O]
      };

      rooms[room].players.forEach((p, idx) => {
        p.emit("start", {
          room,
          grid: +grid,
          yourMark: idx === 0 ? "X" : "O",
          opponentMark: idx === 0 ? "O" : "X",
          turn: 0
        });
      });

    } else {
      waiting[grid] = socket;
      socket.emit("waitingOpponent");
      waitTimer = setTimeout(() => {
        if (waiting[grid] === socket) {
          waiting[grid] = null;
          socket.emit("timeout");
        }
      }, WAIT_TIMEOUT);
    }
  });

  socket.on("cancelWait", ({ grid }) => {
    grid = String(grid);
    if (waiting[grid] === socket) {
      clearTimeout(waitTimer);
      waiting[grid] = null;
      socket.emit("gotoMenu");
    }
  });

  socket.on("move", ({ room, idx }) => {
    const game = rooms[room];
    if (!game || game.gameOver) return;

    const meIdx = game.players.findIndex(p => p.id === socket.id);
    if (meIdx !== game.turn) return;

    const mark = game.turn === 0 ? "X" : "O";
    if (!game.board[idx]) {
      game.board[idx] = mark;

      const g = game.grid;
      const lines = [];
      for (let i = 0; i < g; i++) {
        const row = [], col = [];
        for (let j = 0; j < g; j++) {
          row.push(i * g + j);
          col.push(j * g + i);
        }
        lines.push(row, col);
      }
      const diag1 = [], diag2 = [];
      for (let i = 0; i < g; i++) {
        diag1.push(i * g + i);
        diag2.push(i * g + (g - 1 - i));
      }
      lines.push(diag1, diag2);

      const winLine = lines.find(L => L.every(i => game.board[i] === mark));
      if (winLine) {
        game.gameOver = true;
        return io.to(room).emit("gameover", { winner: mark, board: game.board, winLine });
      }

      if (game.board.every(c => c !== null)) {
        game.gameOver = true;
        return io.to(room).emit("gameover", { winner: null, board: game.board, winLine: [] });
      }

      game.turn = 1 - game.turn;
      io.to(room).emit("update", { board: game.board, turn: game.turn });
    }
  });

  socket.on("rematchRequest", ({ room }) => {
    const game = rooms[room];
    if (!game) return;

    game.rematchReq[socket.id] = true;
    game.players.forEach(p => {
      if (p.id !== socket.id) p.emit("opponentRematch");
    });

    if (Object.keys(game.rematchReq).length === 2) {
      game.board.fill(null);
      game.turn = 0;
      game.gameOver = false;
      game.rematchReq = {};
      game.players.reverse();
      game.players.forEach((p, idx) => {
        p.emit("rematchStart", {
          yourMark: idx === 0 ? "X" : "O",
          opponentMark: idx === 0 ? "O" : "X",
          turn: 0
        });
      });
    }
  });

  socket.on("backToMenu", ({ room }) => {
    const game = rooms[room];
    if (!game) return;

    game.players.forEach(p => {
      if (p.id !== socket.id) {
        p.emit("opponentLeft");
      }
    });

    socket.emit("gotoMenu");
    delete rooms[room];
  });

  socket.on("disconnect", () => {
    clearTimeout(waitTimer);
    for (const g in waiting) {
      if (waiting[g] === socket) waiting[g] = null;
    }
    for (const room in rooms) {
      const game = rooms[room];
      const idx = game.players.findIndex(p => p.id === socket.id);
      if (idx !== -1 && !game.gameOver) {
        const other = game.players[1 - idx];
        other.emit("opponentLeft");
        other.emit("gameover", {
          winner: idx === 0 ? "O" : "X",
          board: game.board,
          winLine: []
        });
        setTimeout(() => other.emit("gotoMenu"), 3000);
        delete rooms[room];
        break;
      }
    }
    // clean up activeUsers on session destroy
    if (socket.request.session && socket.request.session.username) {
      activeUsers.delete(socket.request.session.username);
    }
  });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
