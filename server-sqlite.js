const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: 'cinema-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Подключение к SQLite
const db = new sqlite3.Database('./cinema.db', sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err);
    } else {
        console.log('Подключено к SQLite базе данных');
    }
});

// Helper function для промисов
const dbAll = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const dbRun = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ id: this.lastID, changes: this.changes });
        });
    });
};

const dbGet = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

// Middleware для проверки аутентификации
const isAuthenticated = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Маршруты
app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'views/index.html'));
});

app.get('/movies', async (req, res) => {
    try {
        const movies = await dbAll(`
            SELECT movies.*, genres.name as genre_name 
            FROM movies 
            LEFT JOIN genres ON movies.genre_id = genres.id
            ORDER BY movies.title
        `);
        res.json(movies);
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/schedule', async (req, res) => {
    try {
        const schedule = await dbAll(`
            SELECT s.*, m.title, m.poster_url, m.duration_minutes, g.name as genre_name
            FROM sessions s
            JOIN movies m ON s.movie_id = m.id
            JOIN genres g ON m.genre_id = g.id
            WHERE s.date >= date('now')
            ORDER BY s.date, s.time
        `);
        res.json(schedule);
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/reviews/:movieId?', async (req, res) => {
    try {
        const movieId = req.params.movieId;
        let reviews;
        
        if (movieId) {
            reviews = await dbAll(`
                SELECT r.*, u.username 
                FROM reviews r
                JOIN users u ON r.user_id = u.id
                WHERE r.movie_id = ?
                ORDER BY r.created_at DESC
            `, [movieId]);
        } else {
            reviews = await dbAll(`
                SELECT r.*, u.username, m.title as movie_title
                FROM reviews r
                JOIN users u ON r.user_id = u.id
                JOIN movies m ON r.movie_id = m.id
                ORDER BY r.created_at DESC
                LIMIT 50
            `);
        }
        res.json(reviews);
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/reviews', isAuthenticated, async (req, res) => {
    try {
        const { movie_id, rating, comment } = req.body;
        const user_id = req.session.user.id;
        
        const result = await dbRun(
            'INSERT INTO reviews (movie_id, user_id, rating, comment) VALUES (?, ?, ?, ?)',
            [movie_id, user_id, rating, comment]
        );
        
        res.json({ success: true, id: result.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: 'Ошибка при добавлении отзыва' });
    }
});

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        console.log('Регистрация:', { username, email });
        
        // Проверка существования пользователя
        const existingUser = await dbGet(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            [username, email]
        );
        
        if (existingUser) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        
        // Хэширование пароля
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Создание пользователя
        const result = await dbRun(
            'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
            [username, email, hashedPassword]
        );
        
        // Получаем созданного пользователя
        const newUser = await dbGet(
            'SELECT id, username, email, role FROM users WHERE id = ?',
            [result.id]
        );
        
        if (!newUser) {
            throw new Error('Пользователь не найден после создания');
        }
        
        console.log('Пользователь создан:', newUser);
        req.session.user = newUser;
        res.json({ success: true, user: newUser });
    } catch (err) {
        console.error('Ошибка регистрации:', err);
        res.status(500).json({ error: 'Ошибка регистрации: ' + err.message });
    }
});

// Вход
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
        
        if (!user) {
            return res.status(401).json({ error: 'Неверные данные' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверные данные' });
        }
        
        delete user.password;
        req.session.user = user;
        res.json({ success: true, user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка входа' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/api/user', (req, res) => {
    if (req.session.user) {
        res.json({ user: req.session.user });
    } else {
        res.json({ user: null });
    }
});

// Покупка билета
app.post('/tickets', isAuthenticated, async (req, res) => {
    try {
        const { session_id, seat_number } = req.body;
        const user_id = req.session.user.id;
        
        // Проверка доступности мест
        const session = await dbGet(
            'SELECT available_seats FROM sessions WHERE id = ?',
            [session_id]
        );
        
        if (session.available_seats <= 0) {
            return res.status(400).json({ error: 'Нет доступных мест' });
        }
        
        // Создание билета
        const result = await dbRun(
            'INSERT INTO tickets (user_id, session_id, seat_number) VALUES (?, ?, ?)',
            [user_id, session_id, seat_number]
        );
        
        // Уменьшение количества доступных мест
        await dbRun(
            'UPDATE sessions SET available_seats = available_seats - 1 WHERE id = ?',
            [session_id]
        );
        
        res.json({ success: true, id: result.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка при покупке билета' });
    }
});

// Статические файлы
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/register.html'));
});

app.get('/schedule', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/schedule.html'));
});

app.get('/reviews', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/reviews.html'));
});
// Добавьте эти маршруты в ваш server-sqlite.js:

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/register.html'));
});

app.get('/schedule', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/schedule.html'));
});

app.get('/reviews', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/reviews.html'));
});

// Это должен быть ПОСЛЕДНИЙ маршрут:
app.get('/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/index.html'));
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});
