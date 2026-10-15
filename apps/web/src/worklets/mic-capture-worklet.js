// mic-capture-worklet — vow 麦克风采集处理器（AudioWorkletGlobalScope）
//
// 按 128 帧渲染量子累积输入，每满 chunkSize（默认 1024 采样，≈23ms@44.1k）transfer 一块给主线程。
//
// 纯 JS 是有意为之：本文件运行在 AudioWorkletGlobalScope（无模块加载器、不经 Vite 转译），
// 由 useMicrophone 经 ?url 引入，dev/prod 同构。
//
// 消息协议：
//   主线程 → 处理器：'stop'（停机，process 返回 false）
//   处理器 → 主线程：Float32Array（已 transfer——主线程侧收到独立缓冲）

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const requested = options && options.processorOptions && options.processorOptions.chunkSize
    this._chunkSize = Number.isInteger(requested) && requested > 0 ? requested : 1024
    this._buf = new Float32Array(this._chunkSize)
    this._fill = 0
    this._active = true
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._active = false
    }
  }

  process(inputs) {
    if (!this._active) return false
    const input = inputs[0]
    const ch = input && input[0]
    if (!ch) return true // 尚无输入连接——保持存活等待

    let off = 0
    while (off < ch.length) {
      const n = Math.min(this._chunkSize - this._fill, ch.length - off)
      this._buf.set(ch.subarray(off, off + n), this._fill)
      this._fill += n
      off += n
      if (this._fill === this._chunkSize) {
        const out = this._buf
        this.port.postMessage(out, [out.buffer]) // transfer：零拷贝
        this._buf = new Float32Array(this._chunkSize)
        this._fill = 0
      }
    }
    return true
  }
}

registerProcessor('mic-capture', MicCaptureProcessor)
