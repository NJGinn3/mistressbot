# MistressBot

A Discord bot that acts as a caring, dominant Mistress persona using OpenAI for replies, stores user preferences and tasks in SQLite, and posts daily reminders.

## Setup

1. Copy `.env.example` to `.env` and fill in the variables.

2. Install dependencies:

```bash
npm install
```

3. Start the bot:

```bash
npm start
# or for development
npm run dev
```

## Features

- Persona-driven AI replies via `!mistress` or mentioning the bot.
- Per-user profile with safeword, limits, preferences, affection/strictness/teasing values.
- Daily tasks, reminders, and aftercare stored in SQLite.
- Admin commands to manage tasks, reminders, aftercare, and view logs.

## Environment variables

See `.env.example`.

## Notes

- This project uses the OpenAI `openai` npm package. Ensure your API key has access to the chosen model.
- Keep the bot token and API keys private.
