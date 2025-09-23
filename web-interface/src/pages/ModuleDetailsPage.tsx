/**
 * Module Details Page
 */

import { useParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { ModuleDetails } from '../components/ModuleDetails';
import { Card, CardContent } from '../components/ui/card';

export function ModuleDetailsPage() {
  const { moduleId } = useParams<{ moduleId: string }>();

  const { data: module, loading, error } = useApi(
    () => fetch(`http://localhost:5506/api/debug/modules/${moduleId || ''}`).then(res => res.json()),
    { autoRefresh: true, refreshInterval: 5000 }
  );

  const handleDebugStart = (moduleId: string) => {
    console.log('Starting debug for module:', moduleId);
  };

  const handleDebugStop = (moduleId: string) => {
    console.log('Stopping debug for module:', moduleId);
  };

  const handleConfigUpdate = (moduleId: string, config: Record<string, any>) => {
    console.log('Updating config for module:', moduleId, config);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">Loading module details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center">
            <h2 className="text-xl font-semibold text-red-600 mb-2">Error</h2>
            <p className="text-gray-600 dark:text-gray-400">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!module) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="max-w-md">
          <CardContent className="p-6 text-center">
            <h2 className="text-xl font-semibold text-gray-600 mb-2">Module Not Found</h2>
            <p className="text-gray-600 dark:text-gray-400">Module with ID '{moduleId || 'unknown'}' not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-7xl mx-auto">
        <ModuleDetails
          moduleId={moduleId || ''}
          module={module}
          onDebugStart={handleDebugStart}
          onDebugStop={handleDebugStop}
          onConfigUpdate={handleConfigUpdate}
        />
      </div>
    </div>
  );
}