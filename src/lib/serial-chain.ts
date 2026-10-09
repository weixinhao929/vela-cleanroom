/**
 * 尾部串行化 promise 链（三处同型实现的共享内核：SQLite 写队列
 * persistence/sqlite.ts 的 enqueueWrite、歌词取词单飞锁 lyrics.ts 的
 * serialized、快捷键对账链 app/handlers/settings-sync.tsx 的
 * shortcutSyncChain）。
 *
 * 统一约束：把异步任务排到链尾按发起顺序执行——并发的 fire-and-forget
 * IPC / 网络请求在运行时一侧不保证按发起顺序落定，交错执行会互相覆盖；
 * 链上任一任务抛错**只影响该任务自身**，链尾吞错续链（调用方仍从返回值
 * 拿到真实的 reject），一个坏任务不能把后续任务永久堵死。
 *
 * 可选的单任务超时只用于「放行链尾」：挂死的任务（对端死锁 / 网络黑洞）
 * 不能永久阻塞后续任务；超时不改写调用方拿到的结果——调用方等的是任务
 * 本身的真实落定，无论多晚（早超时早拒绝会让 persist-first 调用方按失败
 * 处理、而迟到成功时内存步骤永不执行，内存与存储静默分叉）。
 */

export interface SerialChainOptions {
  /** 单任务挂起超过该毫秒数后放行链尾（链继续接新任务）；缺省不启用。
   *  不影响调用方拿到的任务 Promise（见文件头注释）。 */
  timeoutMs?: number;
  /** 超时发生时的日志钩子（默认静默——是否记日志由调用方决定）。 */
  onTimeout?: () => void;
}

export interface SerialChain {
  /** 把任务排到链尾执行；返回任务本身的 Promise（真实结果/错误）。 */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** 等待链上现有任务全部落定（不含等待期间新入队的）。 */
  flush(): Promise<void>;
}

function withChainTimeout(p: Promise<unknown>, ms: number, onTimeout?: () => void): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      // 链视角只关心「可以继续了」：超时即放行，任务迟到落定被忽略。
      resolve(undefined);
    }, ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}

/** 创建一条串行链。链是互不共享的独立实例——各调用方各自的顺序约束
 *  （DB 写序 / 取词单飞 / 对账轮次）不应互相排队。 */
export function createSerialChain(options: SerialChainOptions = {}): SerialChain {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    // 前任务无论成败都执行本任务（tail 本就不 reject，第二参是防御性兜底）。
    const run = tail.then(task, task);
    let progressed = run.then(
      () => undefined,
      // 吞错续链：错误只经 run 交给本任务的调用方，不传染链尾。
      () => undefined
    );
    if (options.timeoutMs !== undefined) {
      progressed = withChainTimeout(progressed, options.timeoutMs, options.onTimeout).then(
        () => undefined,
        () => undefined
      );
    }
    tail = progressed;
    return run;
  };
  return {
    enqueue,
    flush: () =>
      tail.then(
        () => undefined,
        () => undefined
      )
  };
}
