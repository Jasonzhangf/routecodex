# RouteCodex Debug Interface

A comprehensive web interface for monitoring and debugging the RouteCodex system with real-time updates, performance visualization, and interactive debugging capabilities.

## Features

### 🎯 Real-time Dashboard
- **Live System Monitoring**: Real-time status updates for all modules
- **Performance Metrics**: CPU, memory, response time, and throughput tracking
- **Event Stream**: Live event logging with filtering and search
- **Health Indicators**: Visual health status for all system components

### 📊 Performance Visualization
- **Interactive Charts**: Line, bar, area, and pie charts using Recharts
- **Real-time Updates**: Live performance metrics with WebSocket integration
- **Historical Data**: Time-based performance analysis
- **Multi-metric Views**: Combined metric visualization

### 🔧 Module Management
- **Module Details**: Detailed view of each module's status and configuration
- **Debug Controls**: Start/stop debugging for individual modules
- **Configuration Management**: Live configuration editing and updates
- **Activity Monitoring**: Module-specific event and performance tracking

### 🔍 Event Explorer
- **Advanced Filtering**: Filter by type, module, time range, and search terms
- **Event Details**: Expandable event details with full context
- **Export Functionality**: Export events in JSON format
- **Real-time Updates**: Live event streaming with WebSocket

### 🎨 User Interface
- **Responsive Design**: Works seamlessly on desktop and mobile devices
- **Dark Mode**: Automatic theme switching with system preferences
- **Modern UI**: Clean, intuitive interface with Tailwind CSS
- **Accessibility**: WCAG-compliant design with keyboard navigation

## Quick Start

### Prerequisites
- Node.js 16.0 or higher
- npm or yarn package manager
- RouteCodex server running on localhost:5506 (default)

### Installation

1. **Clone and navigate to the web interface directory**:
   ```bash
   cd web-interface
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables** (optional):
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Start the development server**:
   ```bash
   npm run dev
   ```

5. **Open your browser**:
   ```
   http://localhost:3000
   ```

### Building for Production

```bash
# Build the application
npm run build

# Preview the production build
npm run preview
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_BASE_URL` | RouteCodex API base URL | `http://localhost:5506` |
| `VITE_API_TIMEOUT` | API request timeout (ms) | `10000` |
| `VITE_WEBSOCKET_URL` | WebSocket server URL | `ws://localhost:5507` |
| `VITE_WEBSOCKET_RECONNECT_INTERVAL` | WebSocket reconnection interval (ms) | `5000` |
| `VITE_WEBSOCKET_MAX_RECONNECT_ATTEMPTS` | Maximum reconnection attempts | `10` |
| `VITE_UI_REFRESH_INTERVAL` | UI refresh interval (ms) | `5000` |
| `VITE_UI_MAX_EVENTS` | Maximum events to display | `1000` |
| `VITE_UI_THEME` | Default theme (`light`, `dark`, `auto`) | `auto` |

### Configuration Files

- **`vite.config.ts`**: Vite build configuration
- **`tailwind.config.js`**: Tailwind CSS configuration
- **`tsconfig.json`**: TypeScript configuration
- **`.eslintrc.json`**: ESLint configuration

## Project Structure

```
web-interface/
├── src/
│   ├── components/          # React components
│   │   ├── ui/            # Base UI components
│   │   ├── Dashboard.tsx  # Main dashboard component
│   │   ├── ModuleDetails.tsx
│   │   ├── EventLog.tsx
│   │   └── PerformanceChart.tsx
│   ├── pages/             # Page components
│   │   ├── ModuleDetailsPage.tsx
│   │   └── NotFoundPage.tsx
│   ├── hooks/             # Custom React hooks
│   │   ├── useWebSocket.ts
│   │   └── useApi.ts
│   ├── services/          # API and WebSocket services
│   │   ├── api.ts
│   │   └── websocket.ts
│   ├── types/             # TypeScript type definitions
│   │   └── index.ts
│   ├── utils/             # Utility functions
│   │   ├── cn.ts
│   │   └── formatters.ts
│   ├── styles/            # CSS styles
│   │   └── globals.css
│   ├── App.tsx            # Main App component
│   └── main.tsx           # Entry point
├── public/                # Static files
├── config/                # Configuration files
├── dist/                  # Build output
└── package.json
```

## API Integration

The web interface connects to the RouteCodex debugging API endpoints:

### Core Endpoints
- `GET /api/debug/health` - System health status
- `GET /api/debug/modules` - Module status list
- `GET /api/debug/modules/:id` - Module details
- `PUT /api/debug/modules/:id/config` - Update module configuration

### Event Endpoints
- `GET /api/debug/events` - Event list with filtering
- `GET /api/debug/events/:id` - Event details
- `DELETE /api/debug/events` - Clear events

### Performance Endpoints
- `GET /api/debug/metrics` - Performance metrics
- `DELETE /api/debug/metrics` - Clear metrics

### Data Management
- `GET /api/debug/export/:format` - Export debug data
- `POST /api/debug/import` - Import debug data
- `DELETE /api/debug/all` - Clear all data

## WebSocket Integration

The interface uses WebSocket for real-time updates:

### Connection
- **URL**: `ws://localhost:5507` (configurable)
- **Protocol**: Socket.IO
- **Auto-reconnect**: Enabled with configurable intervals

### Event Types
- `debug_event` - Debug events
- `module_status` - Module status updates
- `system_health` - System health updates
- `performance_metrics` - Performance metrics
- `error_event` - Error events
- `log_event` - Log events

### Commands
- `start_debugging` - Start debugging a module
- `stop_debugging` - Stop debugging a module
- `clear_events` - Clear event history
- `export_data` - Export data
- `subscribe_events` - Subscribe to event types
- `subscribe_modules` - Subscribe to module updates

## Development

### Available Scripts

```bash
# Development server with hot reload
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Type checking
npm run type-check

# Linting
npm run lint

# Lint and fix
npm run lint:fix
```

### Code Standards

- **TypeScript**: Strict type checking enabled
- **ESLint**: Code linting with React rules
- **Prettier**: Code formatting (if configured)
- **Component Structure**: Functional components with hooks
- **State Management**: Zustand for global state
- **Styling**: Tailwind CSS utility-first approach

### Testing

Currently, the project doesn't include automated tests. For production use, consider adding:

- **Unit Tests**: Jest + React Testing Library
- **Integration Tests**: React Router Testing
- **E2E Tests**: Cypress or Playwright

## Deployment

### Static Hosting

The built application can be deployed to any static hosting service:

1. **Build the application**:
   ```bash
   npm run build
   ```

2. **Deploy the `dist` folder** to your hosting service.

### Environment-specific Builds

Create different configuration files for different environments:

```bash
# Development
cp .env.example .env.development
# Edit for development settings

# Production
cp .env.example .env.production
# Edit for production settings
```

### Docker Deployment

```dockerfile
FROM node:18-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

## Troubleshooting

### Common Issues

1. **WebSocket Connection Failed**
   - Check if the RouteCodex WebSocket server is running
   - Verify the WebSocket URL in environment variables
   - Check network connectivity and firewall settings

2. **API Requests Failed**
   - Verify the RouteCodex API server is running
   - Check API base URL configuration
   - Ensure CORS is properly configured on the server

3. **Build Errors**
   - Clear node_modules and reinstall: `rm -rf node_modules package-lock.json && npm install`
   - Update TypeScript and dependencies: `npm update`
   - Check for TypeScript errors in the IDE

4. **Performance Issues**
   - Reduce `VITE_UI_MAX_EVENTS` for better performance
   - Increase `VITE_UI_REFRESH_INTERVAL` to reduce load
   - Use browser dev tools to identify bottlenecks

### Debug Mode

Enable debug logging by setting the log level in environment variables:

```bash
# Add to .env
VITE_LOG_LEVEL=debug
```

## Contributing

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes and test them**
4. **Commit your changes**: `git commit -m 'Add amazing feature'`
5. **Push to the branch**: `git push origin feature/amazing-feature`
6. **Open a Pull Request**

### Development Guidelines

- Follow the existing code style and structure
- Add TypeScript types for new components and functions
- Include appropriate comments and documentation
- Test your changes thoroughly
- Update documentation as needed

## License

This project is part of the RouteCodex system and is subject to the same license terms.

## Support

For issues and questions:
- Check the troubleshooting section above
- Review the RouteCodex main documentation
- Open an issue in the repository with detailed information

## Changelog

### v1.0.0 (Current)
- Initial release with full debugging interface
- Real-time dashboard with WebSocket integration
- Performance visualization with interactive charts
- Module management and debugging controls
- Event explorer with advanced filtering
- Responsive design with dark mode support
- Export and import functionality for debug data