import { BryntumGantt } from '@bryntum/gantt-react-community';

const project = {
  startDate: '2026-11-09',
  tasks: [{ id: 1, name: 'Factory run, batch 1', startDate: '2026-11-09', duration: 5 }],
};

export function App() {
  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <h1 style={{ margin: '12px 16px', font: '600 20px system-ui' }}>Batchday</h1>
      <div style={{ flex: 1 }}>
        <BryntumGantt project={project} columns={[{ type: 'name', width: 240 }]} />
      </div>
    </main>
  );
}
