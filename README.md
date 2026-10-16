# Psychology of Learning — Quiz

Practice quiz for the NPTEL *Psychology of Learning* weekly assignments (IIT Kharagpur).
498 questions from four runs of the course: 2026 (weeks 0–12, with 7A and 7B), 2025, 2024 and 2023.

- **Home**: progress per year, continue where you left off, repeated-question drill.
- **Quiz**: pick a year and a week tab (or All); each set keeps its own progress. Shuffle, explanations on wrong answers, auto-advance on right answers, retry mistakes.
- **Study**: every question with its answer and explanation, filtered by year/week, searchable.
- **Mixed drill**: any combination of years and weeks.

Past-year questions (2023–2025) were sourced from [mynptel.vercel.app](https://mynptel.vercel.app/psychology-of-learning.html); explanations here are written separately.

Static site, no build step needed to serve. Questions live in `data/<year>/weekNN.json`; run `python3 build.py` to regenerate `questions.js` after editing them.
