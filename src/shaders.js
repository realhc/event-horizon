/** GPU shaders. Distances are expressed in Schwarzschild-radius units.
 * The ray equation uses a Schwarzschild-inspired central acceleration;
 * spin adds a small artistic dragging term, not a complete Kerr metric.
 */
export const fullscreenVertex = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const sceneFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uResolution;
uniform float uTime;
uniform float uMass;
uniform float uSpin;
uniform float uInclination;
uniform float uYaw;
uniform float uDistance;
uniform float uTemperature;
uniform float uOuter;
uniform float uStars;
uniform bool uLensing;
uniform bool uDoppler;
uniform bool uDisk;
uniform int uSteps;
uniform float uStepSize;
const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float n = 0.5 * noise(p);
  p = mat2(1.6, 1.2, -1.2, 1.6) * p;
  n += 0.25 * noise(p);
  p = mat2(1.6, 1.2, -1.2, 1.6) * p;
  return n + 0.125 * noise(p);
}
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1000.0, 30000.0) / 100.0;
  float r = t <= 66.0 ? 1.0 : 1.292936 * pow(t - 60.0, -0.133205);
  float g = t <= 66.0 ? 0.390082 * log(t) - 0.631841 : 1.129891 * pow(t - 60.0, -0.075515);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : 0.543207 * log(t - 10.0) - 1.196254);
  return clamp(vec3(r, g, b), 0.0, 1.0);
}
vec3 sky(vec3 direction) {
  vec2 sphere = vec2(atan(direction.z, direction.x) / TAU + 0.5,
                     asin(clamp(direction.y, -1.0, 1.0)) / PI + 0.5);
  vec3 light = vec3(0.0010, 0.0018, 0.0034);
  float band = exp(-pow((direction.y + 0.18 * direction.x + 0.12) * 7.0, 2.0));
  float dust = fbm(sphere * vec2(28.0, 17.0));
  light += vec3(0.009, 0.012, 0.021) * band * dust * dust * uStars;
  for (int layer = 0; layer < 3; layer++) {
    float scale = layer == 0 ? 240.0 : (layer == 1 ? 480.0 : 920.0);
    vec2 grid = sphere * vec2(scale * 2.0, scale);
    vec2 cell = floor(grid), f = fract(grid);
    vec2 point = hash22(cell + float(layer) * 83.17);
    float seed = hash12(cell + float(layer) * 37.73);
    float presence = step(layer == 0 ? 0.989 : 0.994, seed);
    float radius = layer == 0 ? 0.062 : 0.047;
    float d = length((f - (0.18 + point * 0.64)) * vec2(1.0, 1.0));
    float core = exp(-d * d / (radius * radius));
    float halo = exp(-d * d / (radius * radius * 7.0)) * 0.11;
    vec3 tint = mix(vec3(0.50, 0.68, 1.0), vec3(1.0, 0.80, 0.53), point.x);
    light += tint * (core + halo) * presence * (0.45 + point.y * 1.6) * uStars;
  }
  return light;
}
vec3 acceleration(vec3 p, vec3 v, float angularMomentum2) {
  if (!uLensing) return vec3(0.0);
  float r2 = max(dot(p, p), 0.72);
  float r = sqrt(r2);
  vec3 central = -1.5 * angularMomentum2 * p / (r2 * r2 * r);
  // Small spin-dependent precession for an interactive visual approximation.
  vec3 dragging = cross(vec3(0.0, 1.0, 0.0), v) * (uSpin * 0.13 / (r2 * r));
  return central + dragging;
}
vec4 diskRadiance(vec3 p, vec3 rayDirection) {
  float r = length(p.xz);
  float inner = 3.0 - 1.25 * uSpin;
  float mask = smoothstep(inner, inner + 0.25, r) * (1.0 - smoothstep(uOuter * 0.83, uOuter, r));
  if (mask <= 0.0001) return vec4(0.0);
  float phi = atan(p.z, p.x);
  float orbital = uTime * (2.0 + uSpin) / pow(max(r, 1.0), 1.5);
  // Periodic angular coordinates prevent a seam where atan wraps.
  vec2 turbulencePoint = vec2(r * 3.1 + sin(phi * 3.0 - orbital) * 0.45,
                              cos(phi * 4.0 - orbital * 1.6) * 2.0 + r * 0.68);
  float turbulent = fbm(turbulencePoint);
  float fine = noise(vec2(r * 15.0 + sin(phi * 7.0 - orbital) * 0.8, sin(phi * 9.0 - orbital * 2.0) * 3.0));
  float rings = 0.5 + 0.5 * sin(r * 22.0 + turbulent * 5.0 + sin(phi * 3.0 - orbital) * 1.1);
  float filaments = 0.26 + 1.65 * turbulent * turbulent + 0.13 * rings + 0.28 * fine;
  float radial = pow(inner / r, 2.2);
  float brightness = 2.6 * radial * filaments * mask * pow(uTemperature / 7000.0, 1.1);
  float gravitational = sqrt(max(0.05, 1.0 - 1.0 / r));
  float shift = gravitational;
  if (uDoppler) {
    vec3 tangent = normalize(vec3(-p.z, 0.0, p.x));
    float beta = clamp(sqrt(0.5 / max(r - 1.0, 0.5)), 0.0, 0.63);
    float approach = dot(tangent, -normalize(rayDirection));
    float doppler = sqrt(1.0 - beta * beta) / max(0.35, 1.0 - beta * approach);
    shift *= doppler;
    brightness *= pow(doppler, 2.8);
  }
  float temperature = uTemperature * pow(inner / r, 0.60) * shift;
  vec3 grade = mix(vec3(1.0, 0.43, 0.15), vec3(0.64, 0.82, 1.0), smoothstep(9000.0, 16000.0, uTemperature));
  vec3 color = blackbody(temperature) * grade;
  brightness *= gravitational * gravitational;
  float opacity = clamp(mask * (0.78 + radial * 0.20), 0.0, 0.98);
  return vec4(color * brightness, opacity);
}
void main() {
  vec2 screen = (vUv * 2.0 - 1.0) * vec2(uResolution.x / uResolution.y, 1.0);
  float polar = radians(uInclination);
  vec3 camera = vec3(sin(polar) * sin(uYaw), cos(polar), sin(polar) * cos(uYaw)) * uDistance / uMass;
  vec3 forward = normalize(-camera);
  vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, forward);
  vec3 p = camera;
  vec3 v = normalize(forward + 0.53 * (screen.x * right + screen.y * up));
  vec3 momentum = cross(p, v);
  float angularMomentum2 = dot(momentum, momentum);
  vec3 radiance = vec3(0.0);
  float transmission = 1.0;
  float closest = length(p);
  bool captured = false;
  bool escaped = false;
  float escapeRadius = max(40.0, length(camera) + 12.0);
  for (int i = 0; i < 240; i++) {
    if (i >= uSteps) break;
    float r = length(p);
    closest = min(closest, r);
    if (r < 1.015) { captured = true; break; }
    if (r > escapeRadius && dot(p, v) > 0.0) { escaped = true; break; }
    float stepLength = clamp(r * uStepSize, 0.038, 2.0) / max(length(v), 0.5);
    vec3 a = acceleration(p, v, angularMomentum2);
    vec3 midV = v + a * (0.5 * stepLength);
    vec3 nextP = p + midV * stepLength;
    vec3 nextV = v + acceleration((p + nextP) * 0.5, midV, angularMomentum2) * stepLength;
    if (uDisk && p.y * nextP.y <= 0.0 && abs(p.y - nextP.y) > 0.000001) {
      float intersection = p.y / (p.y - nextP.y);
      vec3 hit = mix(p, nextP, intersection);
      vec4 emission = diskRadiance(hit, mix(v, nextV, intersection));
      radiance += transmission * emission.rgb * emission.a;
      transmission *= 1.0 - emission.a;
      if (transmission < 0.012) break;
    }
    p = nextP;
    v = nextV;
  }
  // The background is sampled along the numerically bent outgoing ray.
  if (!captured && (escaped || length(p) > 8.0)) radiance += transmission * sky(normalize(v));
  // A very subtle path-derived photon glow, for visual readability.
  if (uDisk && uLensing && !captured) {
    float photon = exp(-pow((closest - 1.52) / 0.055, 2.0));
    radiance += vec3(1.0, 0.37, 0.09) * photon * 0.12;
  }
  outColor = vec4(radiance, 1.0);
}`;

export const bloomFragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform bool uThreshold;
vec3 sampleLight(vec2 uv) {
  vec3 c = texture(uSource, uv).rgb;
  if (uThreshold) {
    float peak = max(c.r, max(c.g, c.b));
    c *= smoothstep(0.5, 1.8, peak);
  }
  return c;
}
void main() {
  vec2 d = uDirection * uTexel * 1.45;
  vec3 c = sampleLight(vUv) * 0.227027;
  c += (sampleLight(vUv + d * 1.384615) + sampleLight(vUv - d * 1.384615)) * 0.316216;
  c += (sampleLight(vUv + d * 3.230769) + sampleLight(vUv - d * 3.230769)) * 0.070270;
  outColor = vec4(c, 1.0);
}`;

export const compositeFragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uResolution;
uniform float uExposure;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 hdr = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * 0.68;
  vec3 color = pow(aces(hdr * uExposure), vec3(1.0 / 2.2));
  float vignette = 1.0 - 0.21 * pow(length((vUv - 0.5) * vec2(1.1, 1.0)), 1.65);
  color *= vignette;
  vec2 px = floor(vUv * uResolution);
  float grain = fract(sin(dot(px, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  color += grain * 0.005;
  outColor = vec4(max(color, vec3(0.0)), 1.0);
}`;
