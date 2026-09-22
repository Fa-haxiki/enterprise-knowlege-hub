import { isTerminalAguiEvent } from './chat-run.service';

describe('isTerminalAguiEvent', () => {
  it('识别终态帧', () => {
    expect(isTerminalAguiEvent({ type: 'RUN_FINISHED' })).toBe(true);
    expect(isTerminalAguiEvent({ type: 'RUN_ERROR' })).toBe(true);
    expect(isTerminalAguiEvent({ type: 'STEP_FINISHED' })).toBe(false);
  });
});
