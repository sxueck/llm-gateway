# LLM Gateway

A lightweight LLM gateway management system based on Portkey Gateway, providing an intuitive Web UI interface for managing multiple LLM providers, virtual keys, routing configurations, and model management.

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
- npm / cnpm
- Docker (optional, for running Portkey Gateway)

### Installation

```bash
# Clone the repository
git clone https://github.com/sxueck/llm-gateway.git
cd llm-gateway

# Install backend dependencies
pnpm install

# Install frontend dependencies
cd web
pnpm install
cd ..
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
DB_PATH=./data/gateway.db
PORTKEY_CONFIG_PATH=./portkey-config/conf.json
LOG_LEVEL=info
JWT_SECRET=your-secret-key-change-this-in-production
```

**Important**: In production, be sure to change `JWT_SECRET` to a strong random string (at least 32 characters).

### Starting the Service

```bash
npm run start:all
```

This command will automatically:
1. Start both frontend and backend services
2. Initialize the database

### Docker Compose Deployment

Please refer to [Docker Deployment Guide](./docs/DOCKER_DEPLOYMENT.md)

### Accessing the Application

- **Web UI**: http://localhost:5173
- **Backend API**: http://localhost:3000
- **Portkey Gateway**: http://localhost:8787 (local access only, not exposed externally)

**Security Note**: Portkey Gateway is configured to listen only on the local loopback address (127.0.0.1). External networks cannot access it directly. All API requests must be forwarded through LLM Gateway to ensure unified authentication and access control.

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
| PORTKEY_CONFIG_PATH | Portkey config file path | ./portkey-config/conf.json |
| LOG_LEVEL | Log level | info |
| JWT_SECRET | JWT secret (at least 32 characters) | Required |
| PUBLIC_URL | Public access URL | http://localhost:3000 |
| DEMO_MODE | Demo mode | false |

## Demo

[Demo](http://demo-api.sxueck.com:3000/)

Account: demo / demo1234

Note: The demo site automatically clears data every 3 days. Please do not enter real API keys.

## Contributing

We welcome issues and pull requests!

## License

MIT License - See [LICENSE](./LICENSE) file for details

## Acknowledgments

- [Portkey Gateway](https://github.com/Portkey-AI/gateway) - Core gateway service
- [Naive UI](https://www.naiveui.com/) - UI component library
- [Fastify](https://www.fastify.io/) - High-performance web framework
