import { BrowserRouter } from 'react-router-dom';

import { SupportChat } from './components/SupportChat';
import { ToastProvider } from './components/ui';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';

/** O chat de suporte e o que só ele precisa (avisos, empresa e roteador para os links do balão). */
export default function LandingChat({ initialOpen }: { initialOpen: boolean }) {
  return (
    <ToastProvider>
      <WorkspaceProvider>
        <BrowserRouter>
          <SupportChat initialOpen={initialOpen} />
        </BrowserRouter>
      </WorkspaceProvider>
    </ToastProvider>
  );
}
