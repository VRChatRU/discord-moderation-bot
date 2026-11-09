# Discord Moderation Bot

Discord moderation, reports, message auditing and scam-account recovery.

1. Install Bun 1.4.4 or newer and run `bun install --frozen-lockfile` in this directory.
2. Copy `example.env` to `.env`, fill the IDs, token, invitation, Kuma URL and optional `RULE_1`–`RULE_11`.
3. Enable **Server Members Intent** and **Message Content Intent** in the Discord Developer Portal. Invite the bot with `bot` and `applications.commands` scopes.
4. Grant **View Channels**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, **Embed Links**, **Attach Files**, **Manage Roles**, **Ban Members**, **Kick Members**, **Manage Messages** and **View Audit Log**. Put its role above the mute role and moderated users. Configure the mute role's channel overwrites to deny sending messages, creating threads and speaking, including other roles' allows. For report pings, make the first `MODERATOR_ROLE_IDS` role mentionable or grant the bot **Mention @everyone, @here, and All Roles** in mod-log.
5. Allow the moderator role in **Server Settings → Integrations → this bot** if needed. Run `bun start`; commands register automatically for `GUILD_ID`.
