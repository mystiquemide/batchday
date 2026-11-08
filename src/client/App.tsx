import { Console } from './Console';
import { Reserve } from './Reserve';
import { Status } from './Status';

export function App() {
  const path = window.location.pathname;
  const reserve = path.match(/^\/r\/([0-9a-f]{32})$/);
  if (reserve) return <Reserve workspaceId={reserve[1]} />;
  const status = path.match(/^\/s\/([0-9a-f]{32})$/);
  if (status) return <Status publicToken={status[1]} />;
  return <Console />;
}
