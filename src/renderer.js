import {
  fullscreenVertex,
  sceneFragment,
  bloomFragment,
  compositeFragment,
} from "./shaders.js";

const QUALITY = {
  performance: { steps: 100, step: 0.073 },
  balanced: { steps: 170, step: 0.045 },
  ultra: { steps: 240, step: 0.032 },
};
const SOFTWARE_GPU =
  /swiftshader|llvmpipe|softpipe|software|microsoft basic render|warp/i;
const KNOWN_GPU =
  /nvidia|geforce|radeon|amd|intel|apple|adreno|mali|powervr|qualcomm|iris|arc\(/i;

/** Fullscreen WebGL2 ray integrator with GPU bloom and filmic tone mapping. */
export class BlackHoleRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.disposed = false;
    this.frames = 0;
    this.targets = [];
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
      premultipliedAlpha: false,
    });
    if (!this.gl)
      throw new Error(
        "此浏览器未提供 WebGL2。请使用支持 WebGL2 的现代浏览器，并启用硬件加速。",
      );
    const gl = this.gl;
    // Resources from this instance remain invalid after a lost context restores.
    this.contextLost = false;
    this.onContextLost = () => {
      this.contextLost = true;
    };
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    this.info = {
      api: "WebGL2",
      renderer,
      hardware: SOFTWARE_GPU.test(renderer)
        ? false
        : KNOWN_GPU.test(renderer)
          ? true
          : null,
    };
    this.hdr = Boolean(gl.getExtension("EXT_color_buffer_float"));
    // Float filtering is optional; WebGL2 half-float textures support linear filtering.
    this.maxTextureSize = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.programs = [];
    try {
      this.scene = this.createProgram(sceneFragment);
      this.bloom = this.createProgram(bloomFragment);
      this.composite = this.createProgram(compositeFragment);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      this.resize();
      this.checkError("初始化");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  createProgram(fragmentSource) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`GPU 着色器编译失败：${message}`);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, fullscreenVertex);
    let fragment;
    try {
      fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    } catch (error) {
      gl.deleteShader(vertex);
      throw error;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`GPU 渲染程序链接失败：${message}`);
    }
    this.programs.push(program);
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const { name } = gl.getActiveUniform(program, i);
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  createTarget(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.hdr ? gl.RGBA16F : gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error("GPU 帧缓冲创建失败，请降低分辨率或更新显卡驱动。");
    }
    return { width, height, texture, framebuffer };
  }

  resize(scale = 0.8) {
    if (this.disposed) throw new Error("渲染器已释放。");
    if (this.contextLost || this.gl.isContextLost())
      throw new Error("WebGL 上下文已丢失，请重新加载页面恢复渲染。");
    const bounds = this.canvas.getBoundingClientRect();
    const ratio =
      Math.min(window.devicePixelRatio || 1, 2) *
      Math.max(0.25, Math.min(scale, 1));
    const width = Math.max(
      1,
      Math.min(
        this.maxTextureSize,
        Math.round((bounds.width || this.canvas.clientWidth || 800) * ratio),
      ),
    );
    const height = Math.max(
      1,
      Math.min(
        this.maxTextureSize,
        Math.round((bounds.height || this.canvas.clientHeight || 600) * ratio),
      ),
    );
    if (
      width === this.canvas.width &&
      height === this.canvas.height &&
      this.targets.length
    )
      return { width, height };
    const gl = this.gl;
    for (const target of this.targets) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    this.targets = [];
    this.canvas.width = width;
    this.canvas.height = height;
    try {
      this.targets.push(this.createTarget(width, height));
      this.targets.push(
        this.createTarget(
          Math.max(1, Math.ceil(width / 4)),
          Math.max(1, Math.ceil(height / 4)),
        ),
      );
      this.targets.push(
        this.createTarget(
          Math.max(1, Math.ceil(width / 4)),
          Math.max(1, Math.ceil(height / 4)),
        ),
      );
    } catch (error) {
      // Preserve a usable WebGL2 path when float attachments are unavailable.
      if (!this.hdr) throw error;
      for (const target of this.targets) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
      this.targets = [];
      this.hdr = false;
      this.targets.push(this.createTarget(width, height));
      this.targets.push(
        this.createTarget(
          Math.max(1, Math.ceil(width / 4)),
          Math.max(1, Math.ceil(height / 4)),
        ),
      );
      this.targets.push(
        this.createTarget(
          Math.max(1, Math.ceil(width / 4)),
          Math.max(1, Math.ceil(height / 4)),
        ),
      );
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.checkError("调整渲染尺寸");
    return { width, height };
  }

  render(timeSeconds, params) {
    if (this.disposed) throw new Error("渲染器已释放。");
    const gl = this.gl;
    if (this.contextLost || gl.isContextLost())
      throw new Error("WebGL 上下文已丢失，请重新加载页面恢复渲染。");
    const quality = QUALITY[params.quality] || QUALITY.balanced;
    const [sceneTarget, bloomX, bloomY] = this.targets;
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneTarget.framebuffer);
    gl.viewport(0, 0, sceneTarget.width, sceneTarget.height);
    gl.useProgram(this.scene.program);
    const u = this.scene.uniforms;
    gl.uniform2f(u.uResolution, sceneTarget.width, sceneTarget.height);
    gl.uniform1f(
      u.uTime,
      Number.isFinite(timeSeconds) ? timeSeconds / params.massScale : 0,
    );
    gl.uniform1f(u.uMass, params.massScale);
    gl.uniform1f(u.uSpin, params.spin);
    gl.uniform1f(u.uInclination, params.inclination);
    gl.uniform1f(u.uYaw, params.yaw);
    gl.uniform1f(u.uDistance, params.distance);
    gl.uniform1f(u.uTemperature, params.temperature);
    gl.uniform1f(u.uOuter, params.diskOuter);
    gl.uniform1f(u.uStars, params.stars);
    gl.uniform1i(u.uLensing, params.lensing ? 1 : 0);
    gl.uniform1i(u.uDoppler, params.doppler ? 1 : 0);
    gl.uniform1i(u.uDisk, params.disk ? 1 : 0);
    gl.uniform1i(u.uSteps, quality.steps);
    gl.uniform1f(u.uStepSize, quality.step);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.bloom.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.bloom.uniforms.uSource, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomX.framebuffer);
    gl.viewport(0, 0, bloomX.width, bloomX.height);
    gl.bindTexture(gl.TEXTURE_2D, sceneTarget.texture);
    // Quarter-resolution texels set a consistent bloom footprint in both axes.
    gl.uniform2f(
      this.bloom.uniforms.uTexel,
      1 / bloomX.width,
      1 / bloomX.height,
    );
    gl.uniform2f(this.bloom.uniforms.uDirection, 1, 0);
    gl.uniform1i(this.bloom.uniforms.uThreshold, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomY.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, bloomX.texture);
    gl.uniform2f(this.bloom.uniforms.uDirection, 0, 1);
    gl.uniform1i(this.bloom.uniforms.uThreshold, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTarget.texture);
    gl.uniform1i(this.composite.uniforms.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomY.texture);
    gl.uniform1i(this.composite.uniforms.uBloom, 1);
    gl.uniform2f(
      this.composite.uniforms.uResolution,
      this.canvas.width,
      this.canvas.height,
    );
    gl.uniform1f(this.composite.uniforms.uExposure, params.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.frames++ % 60 === 0) this.checkError("渲染");
  }

  checkError(stage) {
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR)
      throw new Error(`${stage}出现 WebGL 错误（0x${error.toString(16)}）。`);
  }

  dispose() {
    if (this.disposed) return;
    const gl = this.gl;
    if (gl && !this.contextLost && !gl.isContextLost()) {
      for (const target of this.targets || []) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
      for (const program of this.programs || []) gl.deleteProgram(program);
      if (this.vao) gl.deleteVertexArray(this.vao);
    }
    this.targets = [];
    if (this.onContextLost)
      this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.programs = [];
    this.disposed = true;
  }
}
