# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Replaced pi with omp as freeDia's conversation engine while keeping the page-aware chat experience unchanged.
- Added omp's subscription sign-in options, including ChatGPT Plus/Pro Codex, Claude Pro/Max, GLM Coding Plan, Kimi, and OpenRouter, alongside API-key providers.
- Moved each chat to its own omp session directory so conversations and their selected models resume across helper processes and browser restarts.
