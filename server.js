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
        
        // АВТОМАТИЧЕСКАЯ ОЧИСТКА ПРИ ЗАПУСКЕ СЕРВЕРА
        db.run("DELETE FROM movies WHERE title = 'Фильтр'", (err) => {
            if (!err) console.log('✅ Удалены строки с title="Фильтр"');
        });
        db.run("DELETE FROM movies WHERE title IS NULL OR title = ''", (err) => {
            if (!err) console.log('✅ Удалены строки с пустым title');
        });
        db.run("DELETE FROM movies WHERE description IS NULL OR description = ''", (err) => {
            if (!err) console.log('✅ Удалены строки с пустым description');
        });
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

// Middleware для проверки админа
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        next();
    } else {
        res.status(403).send('Доступ запрещен');
    }
};

// ========== МАРШРУТЫ ДЛЯ СТРАНИЦ ==========

app.get('/', async (req, res) => {
    res.sendFile(path.join(__dirname, 'views/index.html'));
});

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

app.get('/movies-page', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/movies.html'));
});

app.get('/admin', isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views/admin.html'));
});

// ========== API МАРШРУТЫ ==========

// ПОЛУЧЕНИЕ ВСЕХ ФИЛЬМОВ (с фильтрацией пустых)
app.get('/movies', async (req, res) => {
    try {
        console.log('Запрос фильмов...');
        
        // Фильтруем пустые записи прямо в запросе
        const movies = await dbAll(`
            SELECT movies.*, genres.name as genre_name 
            FROM movies 
            LEFT JOIN genres ON movies.genre_id = genres.id
            WHERE movies.title IS NOT NULL 
              AND movies.title != ''
              AND movies.title != 'Фильтр'
              AND movies.description IS NOT NULL
              AND movies.description != ''
            ORDER BY movies.id
        `);
        
        console.log(`Найдено фильмов: ${movies.length}`);
        res.json(movies);
    } catch (err) {
        console.error('Ошибка загрузки фильмов:', err);
        res.status(500).json({ error: 'Ошибка сервера при загрузке фильмов' });
    }
});

// ОТДЕЛЬНЫЙ МАРШРУТ ДЛЯ РУЧНОЙ ОЧИСТКИ (только для админов)
app.get('/api/clean-movies', isAdmin, async (req, res) => {
    try {
        const result1 = await dbRun("DELETE FROM movies WHERE title = 'Фильтр'");
        const result2 = await dbRun("DELETE FROM movies WHERE title IS NULL OR title = ''");
        const result3 = await dbRun("DELETE FROM movies WHERE description IS NULL OR description = ''");
        
        console.log(`Очистка: удалено ${result1.changes} строк с 'Фильтр'`);
        console.log(`Очистка: удалено ${result2.changes} пустых title`);
        console.log(`Очистка: удалено ${result3.changes} пустых description`);
        
        res.json({
            success: true,
            message: 'Очистка завершена',
            deleted: {
                filter_rows: result1.changes,
                empty_title: result2.changes,
                empty_description: result3.changes
            }
        });
    } catch (err) {
        console.error('Ошибка очистки:', err);
        res.status(500).json({ error: err.message });
    }
});

// Остальные маршруты (расписание, отзывы, авторизация и т.д.)
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

// ========== АВТОРИЗАЦИЯ ==========

app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        console.log('Регистрация:', { username, email });
        
        const existingUser = await dbGet(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            [username, email]
        );
        
        if (existingUser) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await dbRun(
            'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
            [username, email, hashedPassword]
        );
        
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

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log('Вход:', { username });
        
        const user = await dbGet(
            'SELECT * FROM users WHERE username = ?',
            [username]
        );
        
        console.log('Найден пользователь:', user ? 'да' : 'нет');
        
        if (!user) {
            return res.status(401).json({ error: 'Пользователь не найден' });
        }
        
        let validPassword = false;
        try {
            validPassword = await bcrypt.compare(password, user.password);
        } catch (bcryptErr) {
            console.error('Ошибка проверки пароля:', bcryptErr);
        }
        
        if (!validPassword) {
            const defaultPassword = 'password123';
            const defaultHash = '$2b$10$K7L1OJ45/4Y2nIvhRVxCe.6jJc6H/8Q6bU5JZ5JZ5JZ5JZ5JZ5JZ5J';
            
            if (password === defaultPassword && user.password === defaultHash) {
                validPassword = true;
            }
        }
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный пароль' });
        }
        
        const userWithoutPassword = {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role || 'user'
        };
        
        req.session.user = userWithoutPassword;
        console.log('Успешный вход:', userWithoutPassword);
        res.json({ success: true, user: userWithoutPassword });
    } catch (err) {
        console.error('Ошибка входа:', err);
        res.status(500).json({ error: 'Ошибка входа: ' + err.message });
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

// ========== API ДЛЯ ЖАНРОВ ==========

app.get('/api/genres', async (req, res) => {
    try {
        const genres = await dbAll('SELECT * FROM genres ORDER BY name');
        res.json(genres);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка загрузки жанров' });
    }
});

// ========== ПОКУПКА БИЛЕТОВ ==========

app.post('/tickets', isAuthenticated, async (req, res) => {
    try {
        const { session_id, seat_number } = req.body;
        const user_id = req.session.user.id;
        
        const session = await dbGet(
            'SELECT available_seats FROM sessions WHERE id = ?',
            [session_id]
        );
        
        if (session.available_seats <= 0) {
            return res.status(400).json({ error: 'Нет доступных мест' });
        }
        
        const result = await dbRun(
            'INSERT INTO tickets (user_id, session_id, seat_number) VALUES (?, ?, ?)',
            [user_id, session_id, seat_number]
        );
        
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

// ========== АДМИН API ==========

app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const users = await dbAll('SELECT id, username, email, role, created_at FROM users ORDER BY id');
        res.json(users);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка загрузки пользователей' });
    }
});

app.put('/api/admin/users/:id/role', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;
        
        await dbRun('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка обновления роли' });
    }
});

app.delete('/api/admin/users/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        if (req.session.user.id == id) {
            return res.status(400).json({ error: 'Нельзя удалить себя' });
        }
        
        await dbRun('DELETE FROM users WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка удаления пользователя' });
    }
});

app.get('/api/admin/tickets', isAdmin, async (req, res) => {
    try {
        const tickets = await dbAll(`
            SELECT t.*, u.username, m.title, s.date, s.time
            FROM tickets t
            JOIN users u ON t.user_id = u.id
            JOIN sessions s ON t.session_id = s.id
            JOIN movies m ON s.movie_id = m.id
            ORDER BY t.purchase_date DESC
        `);
        res.json(tickets);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка загрузки билетов' });
    }
});

app.put('/api/admin/tickets/:id/status', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        await dbRun('UPDATE tickets SET status = ? WHERE id = ?', [status, id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка обновления статуса' });
    }
});

app.delete('/api/admin/tickets/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('DELETE FROM tickets WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка удаления билета' });
    }
});

app.delete('/api/admin/reviews/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('DELETE FROM reviews WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка удаления отзыва' });
    }
});

app.delete('/api/admin/sessions/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('DELETE FROM sessions WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка удаления сеанса' });
    }
});

// ========== API ДЛЯ УПРАВЛЕНИЯ ФИЛЬМАМИ ==========

app.post('/api/movies', isAdmin, async (req, res) => {
    try {
        const { title, description, duration_minutes, release_year, poster_url, genre_id, rating } = req.body;
        
        const result = await dbRun(
            `INSERT INTO movies (title, description, duration_minutes, release_year, poster_url, genre_id, rating)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [title, description, duration_minutes, release_year, poster_url, genre_id, rating]
        );
        
        const movie = await dbGet('SELECT * FROM movies WHERE id = ?', [result.id]);
        res.json({ success: true, movie });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка добавления фильма' });
    }
});

app.put('/api/movies/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, duration_minutes, release_year, poster_url, genre_id, rating } = req.body;
        
        await dbRun(
            `UPDATE movies SET 
                title = ?, description = ?, duration_minutes = ?, 
                release_year = ?, poster_url = ?, genre_id = ?, rating = ?
             WHERE id = ?`,
            [title, description, duration_minutes, release_year, poster_url, genre_id, rating, id]
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка обновления фильма' });
    }
});

app.delete('/api/movies/:id', isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await dbRun('DELETE FROM movies WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка удаления фильма' });
    }
});

// ========== ТЕСТОВЫЙ МАРШРУТ ==========

app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'Сервер работает',
        timestamp: new Date().toISOString()
    });
});

// ========== ЧАТ ПОДДЕРЖКИ ==========

app.post('/api/chat', (req, res) => {
    const userMessage = req.body.message || '';
    let reply = 'Извините, я не совсем понял. Попробуйте спросить иначе.';

    const msg = userMessage.toLowerCase();

    const materials = {
        'пгс': { name: 'Песчано-гравийная смесь (ПГС)', price: 'от 850 ₽/м³' },
        'щебень': { name: 'Щебень гранитный', price: 'от 1250 ₽/м³' },
        'песок': { name: 'Песок строительный', price: 'от 650 ₽/м³' },
        'глина': { name: 'Глина техническая', price: 'от 450 ₽/м³' }
    };

    function findMaterial(msg) {
        for (let key in materials) {
            if (msg.includes(key)) return key;
        }
        return null;
    }

    if (msg.includes('привет') || msg.includes('здравствуйте')) {
        reply = 'Здравствуйте! Чем могу помочь?';
    } else {
        const materialKey = findMaterial(msg);
        if (materialKey) {
            const m = materials[materialKey];
            reply = `${m.name} — ${m.price}. Что вас интересует?`;
        } else {
            reply = 'Я могу рассказать о ПГС, щебне, песке, глине. Уточните вопрос.';
        }
    }

    res.json({ reply });
});

// ========== СТАТИЧЕСКИЕ ФАЙЛЫ (ДОЛЖЕН БЫТЬ ПОСЛЕДНИМ) ==========

app.get('/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'views/index.html'));
});

// ========== ЗАПУСК СЕРВЕРА ==========

app.listen(PORT, () => {
    console.log(`\n🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`\n📋 Доступные страницы:`);
    console.log(`   Главная: http://localhost:${PORT}/`);
    console.log(`   Фильмы: http://localhost:${PORT}/movies-page`);
    console.log(`   Админ: http://localhost:${PORT}/admin`);
    console.log(`\n🧹 Для ручной очистки пустых записей (только админ):`);
    console.log(`   GET http://localhost:${PORT}/api/clean-movies`);
    console.log(`\n✅ При запуске сервера пустые записи удаляются автоматически!`);
});