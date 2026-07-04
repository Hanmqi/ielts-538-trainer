# IELTS 538 Daily Synonym Trainer

A mobile-friendly PWA for IELTS Reading synonym-replacement practice.

Live app:

https://hanmqi.github.io/ielts-538-trainer/

## What It Trains

This trainer is built for fast recognition between IELTS reading question words and passage replacement expressions.

It is not a normal vocabulary list. The main goal is to build the reaction:

```text
question word -> passage synonym replacement -> fast recognition
```

Example:

```text
resemble -> be similar to / like / look
```

## Current Features

- Daily word groups in the original 538 order
- Word cards with browser speech playback
- Multiple-choice synonym tests
- Matching exercise: today's main words vs primary replacements
- Mistake notebook
- Review queue based on a simple forgetting-curve schedule
- Local progress saved in the browser
- PWA support for adding to a phone home screen

## Daily Learning Logic

The daily group follows the source order instead of random selection.

Default daily size:

```text
20 words
```

Supported sizes:

```text
10 / 15 / 20 / 30
```

Changing the daily size changes the size of the current day's group.

## Test Logic

Each day generates:

```text
daily word count * 2 questions
```

For example, 20 daily words produce 40 questions.

The test guarantees coverage of:

- each today's main word as a prompt
- each today's primary replacement as a prompt

Prompts and answers are selected from:

- main word
- primary replacement
- all listed replacements

Options are generated from today's and previously learned words.

## Review Logic

Words enter the review queue after learning, incorrect answers, or matching mistakes.

The current review intervals are:

```text
1 day, 2 days, 4 days, 7 days, 15 days, 30 days
```

Incorrect answers are scheduled for earlier review and are also added to the mistake notebook.

## Phone Installation

Open the live app on your phone:

https://hanmqi.github.io/ielts-538-trainer/

Then install it:

- iPhone Safari: Share -> Add to Home Screen
- Android Chrome: Menu -> Install app / Add to Home screen

Progress is stored locally in the browser on each device. Phone and computer progress are not synced.

## Local Development

Run a local static server from the project root:

```powershell
py -m http.server 8765 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8765/index.html
```

Do not open `index.html` directly by double-clicking. The app loads JSON data, and browsers usually block local file reads from `file://`.

## Data

The app currently uses:

```text
ielts538_json_enriched/words.json
```

Only the data required by the web trainer is deployed.

## Deployment

The app is deployed with GitHub Pages through GitHub Actions.

Workflow:

```text
.github/workflows/pages.yml
```

Public site:

```text
https://hanmqi.github.io/ielts-538-trainer/
```
