/**
 * Event Log Component
 */

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { DebugEvent } from '../types';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Database,
  Download,
  Search,
  Trash2,
  XCircle,
  Zap
} from 'lucide-react';
import { formatRelativeTime } from '../utils/formatters';

interface EventLogProps {
  events: DebugEvent[];
  maxEvents?: number;
}

export function EventLog({ events, maxEvents = 50 }: EventLogProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [moduleIdFilter, setModuleIdFilter] = useState<string>('all');
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

  const toggleEventExpansion = (eventId: string) => {
    setExpandedEvents(prev => {
      const newSet = new Set(prev);
      if (newSet.has(eventId)) {
        newSet.delete(eventId);
      } else {
        newSet.add(eventId);
      }
      return newSet;
    });
  };

  const getEventIcon = (type: string) => {
    switch (type) {
      case 'debug':
        return <Zap className="w-4 h-4" />;
      case 'log':
        return <Database className="w-4 h-4" />;
      case 'error':
        return <XCircle className="w-4 h-4" />;
      case 'performance':
        return <CheckCircle className="w-4 h-4" />;
      case 'system':
        return <Clock className="w-4 h-4" />;
      default:
        return <AlertCircle className="w-4 h-4" />;
    }
  };

  const getEventColor = (type: string) => {
    switch (type) {
      case 'debug':
        return 'text-blue-600 bg-blue-100 dark:bg-blue-900 dark:text-blue-200';
      case 'log':
        return 'text-gray-600 bg-gray-100 dark:bg-gray-900 dark:text-gray-200';
      case 'error':
        return 'text-red-600 bg-red-100 dark:bg-red-900 dark:text-red-200';
      case 'performance':
        return 'text-green-600 bg-green-100 dark:bg-green-900 dark:text-green-200';
      case 'system':
        return 'text-purple-600 bg-purple-100 dark:bg-purple-900 dark:text-purple-200';
      default:
        return 'text-gray-600 bg-gray-100 dark:bg-gray-900 dark:text-gray-200';
    }
  };

  // Filter events
  const filteredEvents = events
    .filter(event => {
      if (typeFilter !== 'all' && event.type !== typeFilter) return false;
      if (moduleIdFilter !== 'all' && event.moduleId !== moduleIdFilter) return false;
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        return (
          event.operationId?.toLowerCase().includes(searchLower) ||
          event.moduleId?.toLowerCase().includes(searchLower) ||
          JSON.stringify(event.data).toLowerCase().includes(searchLower)
        );
      }
      return true;
    })
    .slice(0, maxEvents);

  // Get unique module IDs and event types
  const moduleIds = Array.from(new Set(events.map((e: any) => e.moduleId).filter(Boolean))) as string[];
  const eventTypes = Array.from(new Set(events.map(e => e.type)));

  const handleExport = () => {
    const dataStr = JSON.stringify(filteredEvents, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `routecodex-events-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    setSearchTerm('');
    setTypeFilter('all');
    setModuleIdFilter('all');
    setExpandedEvents(new Set());
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col space-y-4">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center space-x-2">
              <Database className="w-5 h-5" />
              <span>Event Log</span>
              <span className="text-sm font-normal text-gray-600 dark:text-gray-400">
                ({filteredEvents.length} events)
              </span>
            </CardTitle>
            <div className="flex items-center space-x-2">
              <Button size="sm" variant="outline" onClick={handleExport}>
                <Download className="w-4 h-4 mr-1" />
                Export
              </Button>
              <Button size="sm" variant="outline" onClick={handleClear}>
                <Trash2 className="w-4 h-4 mr-1" />
                Clear
              </Button>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <Input
                placeholder="Search events..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>

            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {eventTypes.map(type => (
                  <SelectItem key={type} value={type}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={moduleIdFilter} onValueChange={setModuleIdFilter}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Module" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Modules</SelectItem>
                {moduleIds.map(id => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="space-y-2 max-h-96 overflow-y-auto custom-scrollbar">
          {filteredEvents.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No events found matching the current filters
            </div>
          ) : (
            filteredEvents.map((event) => (
              <div
                key={event.id}
                className={`p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer ${
                  expandedEvents.has(event.id) ? 'bg-gray-50 dark:bg-gray-800' : ''
                }`}
                onClick={() => toggleEventExpansion(event.id)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-3 flex-1">
                    <div className={`p-1.5 rounded-md ${getEventColor(event.type)}`}>
                      {getEventIcon(event.type)}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center space-x-2">
                        <h4 className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {event.operationId || 'Unknown Operation'}
                        </h4>
                        {event.moduleId && (
                          <span className="text-xs text-gray-600 dark:text-gray-400">
                            {event.moduleId}
                          </span>
                        )}
                      </div>

                      <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                        {formatRelativeTime(event.timestamp)}
                      </p>

                      {expandedEvents.has(event.id) && (
                        <div className="mt-3 space-y-2">
                          <div className="text-xs text-gray-600 dark:text-gray-400">
                            <strong>Type:</strong> {event.type}
                          </div>
                          <div className="text-xs text-gray-600 dark:text-gray-400">
                            <strong>Session ID:</strong> {event.sessionId || 'N/A'}
                          </div>
                          {event.data && Object.keys(event.data).length > 0 && (
                            <div className="text-xs">
                              <strong className="text-gray-600 dark:text-gray-400">Data:</strong>
                              <pre className="mt-1 p-2 bg-gray-100 dark:bg-gray-900 rounded text-xs overflow-x-auto">
                                {JSON.stringify(event.data, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 ml-2">
                    <span className={`text-xs px-2 py-1 rounded-full ${getEventColor(event.type)}`}>
                      {event.type}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}