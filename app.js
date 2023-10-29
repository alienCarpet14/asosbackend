const express = require('express');
const pg = require('pg');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('./database_credentials');

const app = express();
const port = 3000;
const PASSWORD = config.PASSWORD;

// PostgreSQL database configuration
const pool = new pg.Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'asos', // Connect to the 'postgres' database by default
    password: PASSWORD,
    port: 5432,
});


app.use(bodyParser.json());

// Check and create the 'asos' database if it doesn't exist
async function createDatabaseIfNotExists() {
    // PostgreSQL database configuration
    const pool = new pg.Pool({
        user: 'postgres',
        host: 'localhost',
        database: 'postgres', // Connect to the 'postgres' database by default
        password: PASSWORD,
        port: 5432,
    });
    const client = await pool.connect();
    try {
        // Check if the database 'asos' exists
        const checkDatabaseQuery = "SELECT 1 FROM pg_database WHERE datname = 'asos'";
        const result = await client.query(checkDatabaseQuery);

        if (result.rows.length === 0) {
            // If the database doesn't exist, create it
            const createDatabaseQuery = 'CREATE DATABASE asos';
            await client.query(createDatabaseQuery);
        }
    } catch (error) {
        console.error('Error checking/creating database:', error);
    } finally {
        client.release();
    }
}

// Check and create the 'users' table if it doesn't exist
async function createTableIfNotExists() {
    const client = await pool.connect();
    try {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS users
            (
                id
                SERIAL
                PRIMARY
                KEY,
                username
                VARCHAR
            (
                255
            ) NOT NULL,
                password VARCHAR
            (
                255
            ) NOT NULL
                )
        `;
        await client.query(createTableQuery);
    } catch (error) {
        console.error('Error creating table:', error);
    } finally {
        client.release();
    }
}


createDatabaseIfNotExists()
    .then(() => createTableIfNotExists())
    .then(() => {
        // The database and table should now exist
        app.post('/register', async (req, res) => {
            try {
                const {username, password} = req.body;

                // Check if the username is already taken
                const client = await pool.connect();
                const existingUser = await client.query('SELECT * FROM users WHERE username = $1', [username]);
                client.release();

                if (existingUser.rows.length > 0) {
                    return res.status(400).json({message: 'Username already in use'});
                }

                // Hash the password
                const hashedPassword = await new Promise((resolve, reject) => {
                    bcrypt.hash(password, 10, (err, hash) => {
                        if (err) {
                            reject(err); // Reject the promise in case of an error
                        } else {
                            resolve(hash); // Resolve the promise with the hash value
                        }
                    });
                });

                // Create a new user
                const newUser = {username, password: hashedPassword};
                const insertQuery = 'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id';
                const client2 = await pool.connect();
                const result = await client2.query(insertQuery, [newUser.username, newUser.password]);
                client2.release();

                res.json({message: 'Registration successful'});
            } catch (error) {
                console.error(error);
                res.status(500).json({message: 'Internal server error'});
            }
        });

        // Login
        app.post('/login', async (req, res) => {
            try {
                const {username, password} = req.body;

                // Find the user by username
                const client = await pool.connect();
                const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);

                if (result.rows.length === 0) {
                    client.release();
                    return res.status(401).json({message: 'Invalid username or password'});
                }

                // Verify the password
                const user = result.rows[0];
                const passwordMatch = await bcrypt.compare(password, user.password);

                if (!passwordMatch) {
                    client.release();
                    return res.status(401).json({message: 'Invalid username or password'});
                }

                // Generate a JWT token
                const token = jwt.sign({username}, 'your-secret-key', {expiresIn: '1h'});

                client.release();
                res.json({message: 'Login successful', token});
            } catch (error) {
                console.error(error);
                res.status(500).json({message: 'Internal server error'});
            }
        });

        app.listen(port, () => {
            console.log(`Server is running on http://localhost:${port}`);
        });
    })
    .catch((error) => {
        console.error('Error creating database or table:', error);
    });