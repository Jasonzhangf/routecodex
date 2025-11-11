# Pipeline V2 Migration Guide

This guide provides step-by-step instructions for migrating from Pipeline V1 to V2 architecture using the hybrid adapter system.

## Overview

The hybrid adapter enables seamless migration with zero downtime through:
- **Gradual traffic shifting** from V1 to V2
- **Real-time health monitoring** with automatic fallback
- **Configuration-driven migration** with rollback support
- **Backward compatibility** with existing infrastructure

## Mode Switch

- Use `ROUTECODEX_PIPELINE_MODE` to select pipeline:
  - `dynamic` → V2 dynamic pipeline (default)
  - `static` → V1 static pipeline
- Legacy `ROUTECODEX_USE_V2` is deprecated. Please migrate to `ROUTECODEX_PIPELINE_MODE`.

## Migration Phases

### Phase 1: Preparation (V1 Mode)
1. **Deploy V2 components alongside V1**
   ```bash
   # V2 components are included, but V1 handles all traffic
   npm run build
   npm run deploy
   ```

2. **Enable health monitoring**
   ```json
   // config/modules.json
   {
     "modules": {
       "hybridpipeline": {
         "enabled": true,
         "config": {
           "mode": "v1",
           "healthCheck": {
             "enabled": true,
             "minSamples": 100
           }
         }
       }
     }
   }
   ```

### Phase 2: Hybrid Mode (Gradual Migration)
1. **Start with 5-10% V2 traffic**
   ```json
   {
     "mode": "hybrid",
     "trafficSplit": {
       "v2Percentage": 5,
       "criteria": { "byHash": true }
     }
   }
   ```

2. **Enable progressive migration**
   ```json
   {
     "migration": {
       "enableProgressive": true,
       "schedule": {
         "startPercentage": 5,
         "targetPercentage": 50,
         "durationHours": 24
       }
     }
   }
   ```

3. **Monitor health metrics**
   ```bash
   curl http://localhost:5506/debug/pipelines
   ```

### Phase 3: V2 Mode (Complete Migration)
1. **Switch to full V2**
   ```json
   {
     "mode": "v2"
   }
   ```

2. **Keep V1 as fallback**
   ```json
   {
     "fallback": {
       "enabled": true,
       "errorTypes": ["timeout", "connection"]
     }
   }
   ```

## Configuration Options

### Traffic Splitting Strategies

#### Hash-based (Recommended)
Consistent routing based on request ID:
```json
{
  "criteria": {
    "byHash": true
  }
}
```

#### Endpoint-based
Different split ratios per endpoint:
```json
{
  "endpointOverrides": {
    "/v1/chat/completions": 20,
    "/v1/messages": 5,
    "/v1/responses": 10
  }
}
```

#### Provider-based
Different split ratios per provider:
```json
{
  "providerOverrides": {
    "openai": 15,
    "anthropic": 10,
    "glm": 20,
    "qwen": 5
  }
}
```

### Health-based Routing
```json
{
  "healthCheck": {
    "enabled": true,
    "errorRateThreshold": 0.05,    // 5%
    "latencyThresholdMs": 5000,    // 5 seconds
    "minSamples": 100
  }
}
```

### Fallback Configuration
```json
{
  "fallback": {
    "enabled": true,
    "errorTypes": ["timeout", "connection", "upstream", "429"],
    "cooldownMs": 120000  // 2 minutes
  }
}
```

## Monitoring

### Health Endpoints
```bash
# Pipeline status
curl http://localhost:5506/debug/pipelines

# Health check
curl http://localhost:5506/health

# Configuration
curl http://localhost:5506/config
```

### Metrics
- **Success rates** by pipeline version
- **Average latency** comparison
- **Error rates** and types
- **Traffic distribution** percentages
- **Migration progress** over time

### Logs
```bash
# Hybrid pipeline logs
tail -f ~/.routecodex/logs/hybrid-pipeline.log

# Health monitoring logs
tail -f ~/.routecodex/logs/health-monitor.log

# Traffic splitting logs
tail -f ~/.routecodex/logs/traffic-splitter.log
```

## Rollback Procedures

### Emergency Rollback
1. **Switch to V1 immediately**
   ```json
   {
     "mode": "v1"
   }
   ```

2. **Restart service**
   ```bash
   npm run restart
   ```

### Graceful Rollback
1. **Reduce V2 traffic gradually**
   ```json
   {
     "trafficSplit": {
       "v2Percentage": 0
     }
   }
   ```

2. **Monitor until traffic is 100% V1**
3. **Switch to V1 mode**

## Troubleshooting

### Common Issues

#### V2 Pipeline Not Loading
- Check V2 configuration in `config/v2-config.json`
- Verify all required module factories are registered
- Check logs for initialization errors

#### High Error Rates in V2
- Review provider configurations
- Check authentication and network connectivity
- Enable debug logging for detailed error analysis

#### Uneven Traffic Distribution
- Verify hash-based routing is enabled
- Check endpoint/provider overrides
- Monitor traffic metrics in real-time

### Debug Commands
```bash
# Validate V2 configuration
npm run config:validate:v2

# Test pipeline routing
npm run test:hybrid-routing

# Check health status
npm run health:check

# Simulate traffic split
npm run test:traffic-split -- --percentage=20
```

## Performance Considerations

### Resource Usage
- **V2 instances** are pre-loaded for performance
- **Memory usage** increases with V2 modules
- **CPU overhead** is minimal during routing

### Latency Impact
- **Routing decision**: <1ms
- **Health monitoring**: background process
- **Traffic splitting**: negligible overhead

## Best Practices

### Migration Strategy
1. **Start small** (5% V2 traffic)
2. **Monitor closely** for 24-48 hours
3. **Gradually increase** based on health metrics
4. **Have rollback plan** ready
5. **Document all changes** and observations

### Configuration Management
- **Version control** all configuration changes
- **Test configurations** in staging environment
- **Use feature flags** for gradual rollout
- **Monitor resource usage** during migration

### Monitoring
- **Set up alerts** for error rate thresholds
- **Track migration progress** with dashboards
- **Log all routing decisions** for analysis
- **Regular health checks** on both versions

## Support

For questions or issues:
1. Check logs in `~/.routecodex/logs/`
2. Review configuration documentation
3. Use debug endpoints for real-time status
4. Check AGENTS.md for architecture guidelines
