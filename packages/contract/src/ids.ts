import { randomUUID } from 'node:crypto';

/** 调用 ID（hub 签发，幂等内化） */
export const newCallId = (): string => `c-${randomUUID().slice(0, 8)}`;
/** 任务 ID */
export const newJobId = (): string => `j-${randomUUID().slice(0, 8)}`;
/** 传输 ID */
export const newTransferId = (): string => `t-${randomUUID().slice(0, 8)}`;
