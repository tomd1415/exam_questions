# OCR J277 Source Materials — Catalogue

This directory holds the OCR-published source materials used as the **pattern source** for the platform: specification, teacher support, sample papers, and three series of past papers, mark schemes, and examiners' reports (May 2022, May 2023, May 2024).

## Status and copyright

All files in this directory are © OCR (Oxford, Cambridge and RSA Examinations).

- These files are used as a *pattern source* for question style, command words, mark tariffs, and misconceptions. They are not served verbatim to pupils.
- They must not be committed to a public repository. Once the project repo is initialised, add `OCR_Docs/` to `.gitignore`.
- Generated questions go through embedding-similarity checks against the text in this directory before they enter the live bank (see [PROMPTS.md](../PROMPTS.md) Family A and [SECURITY_AND_PRIVACY.md](../SECURITY_AND_PRIVACY.md)).

## Folder layout

```
OCR_Docs/
├── CONTENT_INDEX.md                       this file
├── specification/
│   └── J277_specification_558027.pdf
├── teacher_support/
│   ├── getting_started_579396.pdf
│   ├── exploring_our_question_papers_562109.pdf
│   └── scheme_of_work_575537.xlsx
├── sample_papers/
│   ├── J277-01_computer_systems/
│   │   └── sample_question_paper_552500.pdf
│   └── J277-02_computational_thinking/
│       └── sample_question_paper_552502.pdf
└── past_papers/
    ├── 2022/
    │   ├── J277-01_computer_systems/
    │   │   ├── question_paper_677830.pdf
    │   │   ├── mark_scheme_677961.pdf
    │   │   └── examiners_report_688265.pdf
    │   └── J277-02_computational_thinking/
    │       ├── question_paper_677831.pdf
    │       ├── mark_scheme_677962.pdf
    │       └── examiners_report_688264.pdf
    ├── 2023/
    │   ├── J277-01_computer_systems/
    │   │   ├── question_paper_704760.pdf
    │   │   ├── mark_scheme_704882.pdf
    │   │   └── examiners_report_704717.pdf
    │   └── J277-02_computational_thinking/
    │       ├── question_paper_704761.pdf
    │       ├── mark_scheme_704883.pdf
    │       └── examiners_report_704716.pdf
    └── 2024/
        ├── J277-01_computer_systems/
        │   ├── question_paper_727534.pdf
        │   ├── mark_scheme_727652.pdf
        │   └── examiners_report_727492.pdf
        └── J277-02_computational_thinking/
            ├── question_paper_727535.pdf
            ├── mark_scheme_727653.pdf
            └── examiners_report_727491.pdf
```

## Naming convention

Folders carry the year and component. Filenames carry the document type and the original OCR identifier (so any file can be cross-referenced back to OCR's catalogue).

`{document_type}_{ocr_id}.pdf`

The OCR id is preserved because OCR re-uses series codes in their support materials, errata, and forum posts; it is the only stable identifier across versions.

## File catalogue

### Specification

| OCR ID | Title | Pages | Notes |
| --- | --- | ---: | --- |
| 558027 | GCSE (9-1) Computer Science J277 — Specification | 49 | Source of truth for topics, subtopics, command words, assessment objectives. |

### Teacher support

| OCR ID | Title | Pages | Notes |
| --- | --- | ---: | --- |
| 579396 | Getting Started with J277 | 5 | Quick-start orientation; mostly URLs to other resources. |
| 562109 | Exploring Our Question Papers | 22 | Examiner walk-through of paper structure, command words, and assessment style. v2.0 (Sep 2024). Highly relevant to question generation prompts. |
| 575537 | Scheme of Work (xlsx) | n/a | Spreadsheet of suggested teaching order. Useful as a baseline curriculum map. |

### Sample papers (accreditation, no live mark scheme bundled)

| Component | OCR ID | Title | Pages |
| --- | --- | --- | ---: |
| J277/01 Computer Systems | 552500 | Sample Question Paper (©2019 accreditation) | 26 |
| J277/02 Computational Thinking, Algorithms and Programming | 552502 | Sample Question Paper (Version 1.6, ©2024 update) | 43 |

Note: J277/02 sample paper was updated to v1.6 in 2024. Cross-check against the live 2024 paper (727535) before relying on its question style.

### Past papers — May 2022 (first live series)

| Component | Document | OCR ID | Pages |
| --- | --- | --- | ---: |
| J277/01 Computer Systems | Question paper | 677830 | 16 |
| J277/01 Computer Systems | Mark scheme | 677961 | 20 |
| J277/01 Computer Systems | Examiner report | 688265 | 29 |
| J277/02 Computational Thinking | Question paper | 677831 | 20 |
| J277/02 Computational Thinking | Mark scheme | 677962 | 19 |
| J277/02 Computational Thinking | Examiner report | 688264 | 30 |

Date sat: Monday 16 May 2022 (afternoon, J277/01).

### Past papers — May 2023

| Component | Document | OCR ID | Pages |
| --- | --- | --- | ---: |
| J277/01 Computer Systems | Question paper | 704760 | 16 |
| J277/01 Computer Systems | Mark scheme | 704882 | 24 |
| J277/01 Computer Systems | Examiner report | 704717 | 26 |
| J277/02 Computational Thinking | Question paper | 704761 | 20 |
| J277/02 Computational Thinking | Mark scheme | 704883 | 32 |
| J277/02 Computational Thinking | Examiner report | 704716 | 31 |

Date sat: Friday 19 May 2023 (afternoon, J277/01).

### Past papers — May 2024

| Component | Document | OCR ID | Pages |
| --- | --- | --- | ---: |
| J277/01 Computer Systems | Question paper | 727534 | 16 |
| J277/01 Computer Systems | Mark scheme | 727652 | 22 |
| J277/01 Computer Systems | Examiner report | 727492 | 25 |
| J277/02 Computational Thinking | Question paper | 727535 | 20 |
| J277/02 Computational Thinking | Mark scheme | 727653 | 27 |
| J277/02 Computational Thinking | Examiner report | 727491 | 27 |

Date sat: Wednesday 15 May 2024 (afternoon, J277/01).

## Paper format facts (from front matter)

- Both papers: 1 hour 30 minutes, no calculator, total 80 marks.
- Quality of extended response assessed in questions marked with an asterisk (*).
- J277/02 advises ~50 minutes on Section A and ~40 minutes on Section B (per sample paper rubric).

## How each source feeds the platform

| Source | Used for | Phase |
| --- | --- | --- |
| Specification | Topic / subtopic / command word seed data | 0 |
| Specification | Generation prompt retrieval pack | 5 |
| Scheme of Work | Suggested curriculum ordering | 0 / 1 |
| Past question papers | Pattern source for question archetypes, mark tariffs, scenario design | 1, 5 |
| Past question papers | Source corpus for similarity checks against generated questions | 5 |
| Mark schemes | Mark-point granularity, accepted-alternative phrasing, contradiction conventions | 1, 3 |
| Examiners' reports | Misconception library, feedback phrasing, "what candidates typically lose marks for" | 1, 3, 6 |
| Sample papers | Reference for question style at first accreditation; less authoritative than live papers | 1, 5 |
| Exploring Our Question Papers | Examiner-authored guidance on style, phrasing and tone for generation prompts | 5 |

## Suggested next steps (not done in this pass)

These are useful but bigger jobs and belong in Phase 0/1 build work, not in cataloguing:

1. **Question-by-question topic mapping.** Tag every past-paper question with topic_code, subtopic_code, command_word_code, archetype_code, marks. This produces the seed of `question_archetypes` and `source_excerpts`.
2. **Mark-scheme parsing.** Extract mark points and accepted alternatives into a structured CSV. Useful both for the curated bank and as exemplars for the marking prompt.
3. **Examiner-report misconception extraction.** Distil the recurring "candidates often..." paragraphs into a `common_misconceptions` seed table.
4. **Spec chunking and embedding.** Once `pgvector` is set up (Phase 5), chunk the spec by subtopic and embed for retrieval.
5. **Forbidden-overlap corpus.** Concatenate all past-paper question stems into `source_excerpts` for the originality check (see [PROMPTS.md](../PROMPTS.md) Family A).

## What is missing from this collection

These are not blockers but worth noting:

- No 2025 series yet (likely available later in 2025 once the embargo lifts).
- No pre-2022 papers (J277 first sat in 2022, so this is correct — the older J276 specification is a different course).
- Sample paper does not include a sample mark scheme in this collection. The 2024 mark schemes (727652, 727653) are the most recent authoritative reference instead.
- No grade boundaries documents.
- No "Candidate exemplars" / "Exemplar candidate work" pack, if OCR has published one for J277.

If any of these surface later, drop them into the matching folder and update this catalogue.
