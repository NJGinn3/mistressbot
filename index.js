require('dotenv').config();
const { Client, GatewayIntentBits, Partials, PermissionsBitField } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { OpenAI } = require('openai');

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// --- Database ---
const db = new sqlite3.Database('./mistressbot.db');

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Constants ---
const CHANNEL_ID = process.env.CHANNEL_ID;
const DAILY_POST_HOUR = parseInt(process.env.DAILY_POST_HOUR || '9', 10);

// --- DB Schema ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    safeword TEXT DEFAULT 'red',
    limits TEXT DEFAULT '',
    preferences TEXT DEFAULT '',
    affection INTEGER DEFAULT 5,
    strictness INTEGER DEFAULT 7,
    teasing INTEGER DEFAULT 7,
    last_seen TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    task_id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    created_by TEXT,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    task_id INTEGER,
    assigned_at TEXT,
    completed_at TEXT,
    status TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reminders (
    reminder_id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    created_by TEXT,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS aftercare (
    aftercare_id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT,
    created_by TEXT,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS logs (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    timestamp TEXT,
    type TEXT,
    message TEXT,
    response TEXT
  )`);
});

// --- Utilities ---
function getNow() {
  return new Date().toISOString();
}

function getUserProfile(userId, username, callback) {
  db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
    if (err) return callback(null);
    if (!row) {
      db.run('INSERT INTO users (user_id, username, last_seen) VALUES (?, ?, ?)', [userId, username, getNow()], (insertErr) => {
        if (insertErr) return callback(null);
        db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err2, row2) => {
          callback(row2);
        });
      });
    } else {
      callback(row);
    }
  });
}

function updateUserProfile(userId, field, value, cb = () => {}) {
  // whitelist fields to avoid SQL injection
  const allowed = new Set(['username','safeword','limits','preferences','affection','strictness','teasing','last_seen']);
  if (!allowed.has(field)) return cb(new Error('Invalid field'));
  db.run(`UPDATE users SET ${field} = ? WHERE user_id = ?`, [value, userId], cb);
}

function logInteraction(userId, message, response, type = 'chat') {
  db.run('INSERT INTO logs (user_id, timestamp, type, message, response) VALUES (?, ?, ?, ?, ?)', [userId, getNow(), type, message, response]);
}

function getRecentLogs(userId, limit, callback) {
  db.all('SELECT message, response FROM logs WHERE user_id = ? ORDER BY log_id DESC LIMIT ?', [userId, limit], (err, rows) => {
    callback(rows || []);
  });
}

function assignDailyTask(userId, callback) {
  const today = new Date().toISOString().split('T')[0];
  db.get(`SELECT id FROM user_tasks WHERE user_id = ? AND assigned_at = ? AND status = 'assigned'`, [userId, today], (err, row) => {
    if (row) return callback();
    db.get('SELECT task_id FROM tasks ORDER BY RANDOM() LIMIT 1', [], (err, taskRow) => {
      if (taskRow) {
        db.run('INSERT INTO user_tasks (user_id, task_id, assigned_at, status) VALUES (?, ?, ?, "assigned")', [userId, taskRow.task_id, today], callback);
      } else {
        callback();
      }
    });
  });
}

function getUserDailyTask(userId, callback) {
  const today = new Date().toISOString().split('T')[0];
  db.get(`SELECT tasks.description FROM user_tasks JOIN tasks ON user_tasks.task_id = tasks.task_id WHERE user_tasks.user_id = ? AND user_tasks.assigned_at = ? AND user_tasks.status = 'assigned'`, [userId, today], (err, row) => {
    callback(row ? row.description : "No task assigned for today.");
  });
}

function completeUserTask(userId, cb = () => {}) {
  const today = new Date().toISOString().split('T')[0];
  db.run(`UPDATE user_tasks SET status = 'completed', completed_at = ? WHERE user_id = ? AND assigned_at = ? AND status = 'assigned'`, [getNow(), userId, today], cb);
}

function getDailyReminder(callback) {
  db.get('SELECT description FROM reminders ORDER BY RANDOM() LIMIT 1', [], (err, row) => {
    callback(row ? row.description : "No daily reminder set.");
  });
}

function getAftercare(callback) {
  db.get('SELECT description FROM aftercare ORDER BY RANDOM() LIMIT 1', [], (err, row) => {
    callback(row ? row.description : "Aftercare is essential. Hydrate, rest, and be gentle to yourself.");
  });
}

// --- AI Mistress Persona ---
async function aiMistressReply(userId, userMessage, username) {
  return new Promise((resolve, reject) => {
    getUserProfile(userId, username, (profile) => {
      if (!profile) return resolve("Sorry, I couldn't load your profile.");
      getRecentLogs(userId, 5, async (logs) => {
        const mood = `Affection=${profile.affection}, Strictness=${profile.strictness}, Teasing=${profile.teasing}`;
        const persona = `You are MistressBot, a dominant, witty, and caring BDSM Mistress. Remember user's safeword: ${profile.safeword}. Limits: ${profile.limits}. Preferences: ${profile.preferences}. Mood: ${mood}. Always be caring and avoid sexual content that violates platform policy.`;

        try {
          const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
              { role: 'system', content: persona },
              { role: 'user', content: userMessage }
            ],
            max_tokens: 200
          });

          const content = response.choices?.[0]?.message?.content || response.choices?.[0]?.text || "(no response)";
          logInteraction(userId, userMessage, content);
          resolve(content);
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}

// --- Command Handler ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  const userId = msg.author.id;
  const username = msg.member ? msg.member.displayName : msg.author.username;
  const args = msg.content.trim().split(/\s+/);
  const command = args.shift();

  // Mention or !mistress to trigger AI
  if (msg.mentions.has(client.user) || command === '!mistress') {
    const text = command === '!mistress' ? args.join(' ') : msg.content.replace(`<@!${client.user?.id}>`, '').trim();
    if (!text) return msg.reply('Please provide a message.');
    try {
      const reply = await aiMistressReply(userId, text, username);
      msg.reply(reply);
    } catch (err) {
      msg.reply('Sorry, I had an error generating a reply.');
    }
    return;
  }

  switch (command) {
    case '!setsafeword':
      if (args.length < 1) return msg.reply('Usage: !setsafeword <word>');
      updateUserProfile(userId, 'safeword', args.join(' '), () => msg.reply('Safeword updated.'));
      break;
    case '!setlimits':
      updateUserProfile(userId, 'limits', args.join(' '), () => msg.reply('Limits updated.'));
      break;
    case '!setprefs':
      updateUserProfile(userId, 'preferences', args.join(' '), () => msg.reply('Preferences updated.'));
      break;
    case '!profile':
      getUserProfile(userId, username, (profile) => {
        if (!profile) return msg.reply('Profile not found.');
        msg.reply(`Safeword: ${profile.safeword}\nLimits: ${profile.limits}\nPreferences: ${profile.preferences}\nAffection: ${profile.affection}\nStrictness: ${profile.strictness}\nTeasing: ${profile.teasing}`);
      });
      break;
    case '!dailytask':
      assignDailyTask(userId, () => {
        getUserDailyTask(userId, (task) => msg.reply(`Your daily task:\n${task}`));
      });
      break;
    case '!taskdone':
      completeUserTask(userId, () => {
        getAftercare((aftercare) => {
          logInteraction(userId, 'Completed my task', aftercare, 'aftercare');
          msg.reply(`Aftercare:\n${aftercare}`);
        });
      });
      break;
    case '!aftercare':
      getAftercare((aftercare) => msg.reply(`Aftercare:\n${aftercare}`));
      break;
    case '!dailyreminder':
      getDailyReminder((reminder) => msg.reply(`Daily Reminder:\n${reminder}`));
      break;
    // Admin commands
    case '!addtask':
      if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return msg.reply('Admin only.');
      db.run('INSERT INTO tasks (description, created_by, created_at) VALUES (?, ?, ?)', [args.join(' '), userId, getNow()]);
      msg.reply('Task added.');
      break;
    case '!deltask':
      if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return msg.reply('Admin only.');
      db.run('DELETE FROM tasks WHERE task_id = ?', [parseInt(args[0])]);
      msg.reply('Task deleted.');
      break;
    case '!addreminder':
      if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return msg.reply('Admin only.');
      db.run('INSERT INTO reminders (description, created_by, created_at) VALUES (?, ?, ?)', [args.join(' '), userId, getNow()]);
      msg.reply('Reminder added.');
      break;
    case '!delreminder':
      if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return msg.reply('Admin only.');
      db.run('DELETE FROM reminders WHERE reminder_id = ?', [parseInt(args[0])]);
      msg.reply('Reminder deleted.');
      break;
    case '!addaftercare':
      if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return msg.reply('Admin only.');
      db.run('INSERT INTO aftercare (description, created_by, created_at) VALUES (?, ?, ?)', [args.join(' '), userId, getNow()]);
      msg.reply('Aftercare added.');
      break;
    case '!delaftercare':
      if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return msg.reply('Admin only.');
      db.run('DELETE FROM aftercare WHERE aftercare_id = ?', [parseInt(args[0])]);
      msg.reply('Aftercare deleted.');
      break;
    case '!admindash':
      if (!msg.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return msg.reply('Admin only.');
      {
        const section = args[0];
        switch (section) {
          case 'users':
            db.all('SELECT * FROM users', [], (err, rows) => {
              msg.reply('User Profiles:\n' + rows.map(r => `${r.username} (ID:${r.user_id}) - Safeword:${r.safeword} Limits:${r.limits} Prefs:${r.preferences}`).join('\n'));
            });
            break;
          case 'tasks':
            db.all('SELECT * FROM tasks', [], (err, rows) => msg.reply('Tasks:\n' + rows.map(r => `${r.task_id}: ${r.description}`).join('\n')));
            break;
          case 'reminders':
            db.all('SELECT * FROM reminders', [], (err, rows) => msg.reply('Reminders:\n' + rows.map(r => `${r.reminder_id}: ${r.description}`).join('\n')));
            break;
          case 'aftercare':
            db.all('SELECT * FROM aftercare', [], (err, rows) => msg.reply('Aftercare:\n' + rows.map(r => `${r.aftercare_id}: ${r.description}`).join('\n')));
            break;
          case 'logs':
            const limit = parseInt(args[1]) || 10;
            db.all('SELECT * FROM logs ORDER BY log_id DESC LIMIT ?', [limit], (err, rows) => msg.reply('Logs:\n' + rows.map(r => `${r.timestamp} [${r.type}] ${r.user_id}: ${r.message} -> ${r.response}`).join('\n')));
            break;
          default:
            msg.reply('Sections: users, tasks, reminders, aftercare, logs');
        }
      }
      break;
    default:
      break;
  }
});

// --- Daily Posting ---
setInterval(() => {
  const now = new Date();
  if (now.getUTCHours() === DAILY_POST_HOUR && now.getUTCMinutes() === 0) {
    getDailyReminder((reminder) => {
      getAftercare((aftercare) => {
        const channel = client.channels.cache.get(CHANNEL_ID);
        if (channel) {
          channel.send(`**Mistress's Daily Reminder:**\n${reminder}`).catch(() => {});
          channel.send(`**Today's Aftercare Tip:**\n${aftercare}`).catch(() => {});
        }
      });
    });
  }
}, 60000);

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));

client.login(process.env.DISCORD_BOT_TOKEN).catch(err => console.error('Login failed', err));
