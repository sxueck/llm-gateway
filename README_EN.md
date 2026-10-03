# LLM Gateway

<div align="center">

[![GitHub Wiki](https://img.shields.io/badge/docs-wiki-blue?style=flat-square)](https://github.com/sxueck/llm-gateway/wiki)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node->=v22-339933?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/bun->=v1.0-black?style=flat-square&logo=bun)](https://bun.sh/)

**English** | [中文](./README.md)

</div>

> A production-grade LLM gateway management system that has stably processed over **5 billion tokens** in three months of deployment (and counting).
>
> Provides an intuitive Web UI interface for managing multiple LLM providers, virtual keys, routing configurations, and model management.

<p align="center">
  <img width="80%" alt="Dashboard" src="https://github.com/user-attachments/assets/a69d7e89-5225-4c2e-bae3-d11faddc9b56" />
</p>

<p align="center">
  <a href="./docs/screenshot.md">More Screenshots</a>
</p>

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Features

| Feature | Description |
|---------|-------------|
| **Provider Management** | Support for 20+ mainstream LLM providers: OpenAI, Anthropic, Google, DeepSeek, etc. |
| **Virtual Keys** | Create and manage virtual API keys with rate limiting and access control |
| **Routing Configuration** | Load balancing and failover strategies to improve service availability |
| **Model Management** | Unified management of models from all providers with batch import and custom configuration |
| **Multi-Endpoint Support** | Compatible with `/v1/chat/completions`, `/v1/responses`, `/v1/messages` and other endpoints |
| **User Authentication** | Secure authentication mechanism based on JWT |
| **Real-time Monitoring** | Dashboard displaying system status and configuration information |
| **Relay Support** | Isolate prompt words forcibly injected by upstreams like Codex, making downstream applications follow Prompt specifications more strictly |
| **Built-in PII Protection** | Automatically detect and mask personal identifiable information in requests, with support for streaming response restoration |

---

## Quick Start

### Prerequisites

| Dependency | Version | Description |
|------------|---------|-------------|
| Node.js | >= v22 | Runtime environment |
| Bun | >= v1.0 | Monorepo scripts based on Bun workspaces |
| MySQL | 8.x | Database (or MySQL-compatible database) |
| Docker | - | Optional, for containerized deployment |
| Minimum Configuration | 1C2G | Requires higher configuration for compute-intensive features like PII privacy protection |

### Installation

```bash
# Clone the repository
git clone https://github.com/sxueck/llm-gateway.git
cd llm-gateway

# Install dependencies (includes packages/backend and packages/web)
bun install
```

### Configuration

Create a `.env` file and configure environment variables:

```bash
cp .env.example .env
```

Edit the `.env` file (at minimum, configure MySQL and `JWT_SECRET`):

```env
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
JWT_SECRET=your-secret-key-change-this-in-production

# MySQL Database Configuration
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-mysql-password
MYSQL_DATABASE=llm_gateway
```

> **Important**: In production, be sure to change `JWT_SECRET` to a strong random string (at least 32 characters).

### Starting the Service

```bash
# Start both backend (3000) and frontend (5173)
bun run dev:all
```

| Service | URL |
|---------|-----|
| Web UI | http://localhost:5173 |
| Backend API | http://localhost:3000 |

**Start separately:**

```bash
# Backend only
bun run dev:backend

# Frontend only
bun run dev:web
```

**Production build and startup (frontend/backend deployed separately):**

```bash
# Build both backend and frontend
bun run build

# Start backend (production mode)
bun run start
```

> Note: Frontend artifacts are located at `packages/web/dist`, please deploy using Nginx or any static file server.

### Docker Compose Deployment

Please refer to the [Docker Deployment Guide](./docs/docker-deployment.md)

### Quick Usage

1. **Add a Provider** - Add an AI service provider like DeepSeek, and enter the provider's API key
2. **Add a Model** - Add an AI model provided by the provider, such as DeepSeek's `deepseek-chat`
3. **Create a Virtual Key** - Used to access the LLM Gateway API
4. **(Optional) Configure Prompt management rules** - To enable dynamic modification and enhancement of prompts
5. **Use the Virtual Key to access the API** - Call LLM Gateway in your application

---

## Contributing

We welcome issues and pull requests!

---

## License

[MIT License](./LICENSE) - LLM Gateway

---

## Acknowledgments

- [Naive UI](https://www.naiveui.com/) - UI component library
- [Fastify](https://www.fastify.io/) - High-performance web framework
