# Indentured Servants

Two Discord bots in one repository. Each bot has its own dependencies, configuration, and process.

| Bot | Purpose | Setup |
| --- | --- | --- |
| RAFFLEYE | Giveaways, winner management, and announcements | [RAFFLEYE guide](RAFFLEYE/README.md) |
| Echoveil | Anonymous confessions with private member settings | [Echoveil guide](Echoveil/README.md) |

## Getting started

Clone this repository, then open the folder for the bot you want to run:

```sh
git clone https://github.com/CS6119/indentured-servants.git
cd indentured-servants/RAFFLEYE
# Or: cd indentured-servants/Echoveil
npm ci
npm run validate
```

Follow the selected bot's setup guide to create its local `.env` file, register commands, and start it. Use separate Discord applications and tokens for the two bots. Run Docker commands from the relevant bot folder too.

Credentials, databases, participant records, confession preferences, logs, and runtime files are excluded. Never commit real `.env` files or runtime data.

GitHub Actions validates both bots independently. RAFFLEYE also includes its Python reference implementation and tests.
