# LLM Gateway

A lightweight LLM gateway management system providing an intuitive Web UI interface for managing multiple LLM providers, virtual keys, routing configurations, and model management.

<img width="2290" height="1363" alt="Screenshot" src="https://github.com/user-attachments/assets/662d8585-b523-40a5-bb2a-33ad570f0d30" />

For more screenshots, see [Service Screenshots](./docs/screenshot.md)

## Features

- **Provider Management**: Support for 20+ mainstream LLM providers, including OpenAI, Anthropic, Google, DeepSeek, etc.
- **Virtual Keys**: Create and manage virtual API keys with support for rate limiting and access control
- **Routing Configuration**: Support for load balancing and failover strategies to improve service availability
- **Model Management**: Unified management of models from all providers with support for batch import and custom configuration
- **Prompt Management**: Configure prompt processing rules for virtual models, supporting replacement, prepending, system messages, and more
- **LiteLLM Preset Integration**: Automatically fetch model configurations from the official LiteLLM library with search and one-click application
- **Intelligent Routing**: Smart request distribution based on model, provider, region, and other rules
- **User Authentication**: Secure authentication mechanism based on JWT
- **Real-time Monitoring**: Dashboard displaying system status and configuration information

## Quick Start

### Prerequisites

- Node.js v20 or higher
- Bun v1.0 or higher (monorepo scripts use Bun workspaces)
- MySQL 8.x (or any MySQL-compatible database)
- Docker (optional)

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

Edit the `.env` file:

```env
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
JWT_SECRET=your-secret-key-change-this-in-production

# MySQL configuration
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-mysql-password
MYSQL_DATABASE=llm_gateway
```

**Important**: In production, be sure to change `JWT_SECRET` to a strong random string (at least 32 characters).

### Starting the Service

```bash
# Start backend (3000) and web (5173)
bun run dev:all
```

Access URLs:
- **Web UI**: http://localhost:5173
- **Backend API**: http://localhost:3000

You can also start them separately:

```bash
# Backend only
bun run dev:backend

# Web only
bun run dev:web
```

Production build & run (frontend/backend deployed separately):

```bash
# Build both backend and web
bun run build

# Start backend (production)
bun run start
```

Frontend artifacts are generated at `packages/web/dist` and should be served by Nginx or any static file server.

### Docker Compose Deployment

Please refer to [Docker Deployment Guide](./docs/docker-deployment.md)

### Accessing the Application

- **Web UI**: http://localhost:5173
- **Backend API**: http://localhost:3000

### Quick Usage

1. Add a provider - a provider refers to an AI service provider like DeepSeek, and enter the provider's API key
2. Add a model - a model refers to an AI model provided by the provider, such as DeepSeek's `deepseek-chat`
3. Create a virtual key - a virtual key is used to access the LLM Gateway API
4. (Optional) Configure Prompt management rules for virtual models to enable dynamic modification and enhancement of prompts
5. Use the virtual key in your application to access the LLM Gateway API

### Environment Variables

See the `.env.example` file for details. Main configuration items:

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Backend service port | 3000 |
| NODE_ENV | Runtime environment | development |
| DB_PATH | Database file path | ./data/gateway.db |
| LOG_LEVEL | Log level | info |
| JWT_SECRET | JWT secret (at least 32 characters) | Required |
| PUBLIC_URL | Public access URL | http://localhost:3000 |

## Contributing

We welcome issues and pull requests!

## License

MIT License - See [LICENSE](./LICENSE) file for details

## Acknowledgments

- [Naive UI](https://www.naiveui.com/) - UI component library
- [Fastify](https://www.fastify.io/) - High-performance web framework
