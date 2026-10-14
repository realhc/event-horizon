/** Illustrative celestial scenes: procedural volume emission and analytic surfaces.
 * These are interactive visual models, not hydrodynamics or stellar evolution.
 * All modes share the existing HDR, bloom, and tone-mapping GPU pipeline.
 */
export const celestialFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uResolution;
uniform int uScene;
uniform int uSteps;
uniform float uTime;
uniform float uInclination;
uniform float uYaw;
uniform float uDistance;
uniform float uTemperature;
uniform float uStars;
uniform float uNebulaDensity;
uniform float uNebulaHue;
uniform float uNebulaTurbulence;
uniform float uGalaxyArms;
uniform float uGalaxyPitch;
uniform float uGalaxyDust;
uniform float uPlanetRadius;
uniform float uRingTilt;
uniform float uRingWidth;
uniform float uPlanetBands;
uniform float uStarActivity;
uniform float uStarCorona;
const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x),
                 mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                 mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float v = noise3(p) * 0.57;
  p = p.yzx * 2.03 + vec3(1.7, 4.1, 2.3);
  v += noise3(p) * 0.28;
  return v + noise3(p.zxy * 2.07 + 6.17) * 0.15;
}
mat2 rotation(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }
vec3 hueColor(float hue) {
  vec3 rgb = clamp(abs(fract(hue + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(0.13), rgb, 0.86);
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
  vec3 light = vec3(0.0008, 0.0014, 0.0031);
  float band = exp(-pow((direction.y + direction.x * 0.21 + 0.12) * 7.0, 2.0));
  light += vec3(0.005, 0.007, 0.013) * band * fbm(direction * 28.0) * uStars;
  for (int layer = 0; layer < 3; layer++) {
    float scale = layer == 0 ? 220.0 : (layer == 1 ? 450.0 : 820.0);
    vec2 grid = sphere * vec2(scale * 2.0, scale);
    vec2 cell = floor(grid), f = fract(grid);
    vec2 point = hash22(cell + float(layer) * 83.17);
    float seed = hash2(cell + float(layer) * 37.73);
    float presence = step(layer == 0 ? 0.986 : 0.994, seed);
    float radius = layer == 0 ? 0.067 : 0.046;
    float d = length(f - (0.18 + point * 0.64));
    float core = exp(-d*d / (radius*radius));
    float halo = exp(-d*d / (radius*radius*7.0)) * 0.12;
    vec3 tint = mix(vec3(0.48,0.67,1.0), vec3(1.0,0.77,0.47), point.x);
    light += tint * (core + halo) * presence * (0.6 + point.y * 1.8) * uStars;
  }
  return light;
}
vec2 sphereInterval(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd), c = dot(ro, ro) - radius*radius;
  float h = b*b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b-h, -b+h);
}

// Emissive, absorbing clouds with asymmetric lobes and a carved central cavity.
vec3 nebula(vec3 ro, vec3 rd) {
  vec2 hit = sphereInterval(ro, rd, 7.1);
  vec3 background = sky(rd);
  if (hit.y <= 0.0) return background;
  float start = max(0.0, hit.x);
  float ds = (hit.y-start) / float(uSteps);
  float jitter = hash2(floor(vUv*uResolution));
  float transmission = 1.0;
  vec3 emission = vec3(0.0);
  float hue = uNebulaHue / 360.0;
  vec3 primary = hueColor(hue);
  vec3 secondary = hueColor(fract(hue - 0.23));
  vec3 warm = hueColor(fract(hue + 0.18));
  float t = uTime * 0.035;
  for (int i = 0; i < 112; i++) {
    if (i >= uSteps || transmission < 0.025) break;
    vec3 p = ro + rd * (start + (float(i)+jitter)*ds);
    vec3 q = p;
    q.xz = rotation(0.19 + t * 0.09) * q.xz;
    float warp = noise3(q * 0.56 + vec3(t, 0.0, -t)) - 0.5;
    q += vec3(sin(q.y*0.9+t), cos(q.z*0.8-t), sin(q.x*0.7)) * warp * uNebulaTurbulence * 1.3;
    float structure = fbm(q * (0.77 + uNebulaTurbulence*0.26) + vec3(t,-t*0.3,t*0.5));
    float lobe = exp(-dot((q-vec3(-1.25,0.5,0.0))*vec3(0.25,0.38,0.30),
                         (q-vec3(-1.25,0.5,0.0))*vec3(0.25,0.38,0.30)));
    lobe += 0.75 * exp(-dot((q-vec3(2.1,-0.9,0.5))*vec3(0.43,0.30,0.40),
                           (q-vec3(2.1,-0.9,0.5))*vec3(0.43,0.30,0.40)));
    float shell = 1.0 - smoothstep(5.8, 7.0, length(p));
    float cavity = length((q - vec3(0.3,0.35,0.8)) * vec3(0.95,1.3,0.8));
    float hollow = smoothstep(0.75, 2.1, cavity + structure * 1.3);
    float wisps = smoothstep(0.30, 0.71, structure);
    float density = lobe * shell * hollow * wisps * uNebulaDensity * 0.66;
    float ridge = pow(clamp(1.0 - abs(structure - 0.57)*3.8, 0.0, 1.0), 4.0);
    float light = 0.46 + 1.9 * ridge + 1.25 * exp(-cavity*0.50);
    float mixColor = smoothstep(-2.4, 2.7, q.y - q.x*0.3 + (structure-0.5)*3.0);
    vec3 color = mix(primary, secondary, mixColor);
    color = mix(color, warm, smoothstep(0.63,0.86,structure)*0.50);
    color = mix(color, vec3(0.72,0.85,1.0), ridge*0.22);
    color *= mix(vec3(1.0), blackbody(uTemperature), 0.16);
    float alpha = 1.0 - exp(-density * ds * 0.85);
    emission += transmission * alpha * color * light * 1.85;
    transmission *= 1.0 - alpha;
  }
  // Background stars remain behind and are attenuated by the cloud column.
  return emission + background * transmission;
}

// Thin, genuinely three-dimensional spiral arms, dust lanes, and central bulge.
vec3 galaxy(vec3 ro, vec3 rd) {
  vec2 hit = sphereInterval(ro, rd, 7.2);
  vec3 background = sky(rd);
  if (hit.y <= 0.0) return background;
  float start = max(0.0, hit.x), ds = (hit.y-start) / float(uSteps);
  float transmission = 1.0;
  vec3 emission = vec3(0.0);
  float jitter = hash2(floor(vUv*uResolution));
  vec3 coreColor = mix(vec3(1.0,0.58,0.24), blackbody(uTemperature*0.72), 0.36);
  vec3 armColor = mix(vec3(0.20,0.40,1.0), blackbody(uTemperature*1.8), 0.30);
  for (int i = 0; i < 112; i++) {
    if (i >= uSteps || transmission < 0.015) break;
    vec3 p = ro + rd * (start + (float(i)+jitter)*ds);
    float r = length(p.xz);
    float taper = 1.0 - smoothstep(5.0,6.9,r);
    float height = exp(-abs(p.y) / (0.14 + r*0.042));
    float theta = atan(p.z,p.x) - uTime*0.026;
    float winding = theta - log(max(r,0.32)) / uGalaxyPitch;
    float phase = winding * uGalaxyArms;
    float arm = pow(0.5 + 0.5*cos(phase), 5.0);
    float dustLane = pow(0.5 + 0.5*cos(phase+0.62), 11.0);
    float detail = fbm(p*3.4 + vec3(uTime*0.025,0.0,0.0));
    float radial = exp(-r*0.25);
    float bulge = exp(-dot(p*vec3(1.3,2.1,1.3),p*vec3(1.3,2.1,1.3))*0.70);
    float density = taper*height*radial*(0.045+arm*0.75) + bulge*1.6;
    float absorption = taper*height*radial*dustLane*uGalaxyDust*(0.20+detail*0.8);
    float sparkle = pow(smoothstep(0.56,0.87,noise3(p*22.0)),7.0) * arm * height * taper;
    vec3 color = mix(armColor, vec3(0.78,0.66,1.0), detail);
    vec3 emissive = color * density * (0.5+detail*1.8);
    emissive += coreColor * bulge * 4.5;
    emissive += vec3(0.67,0.77,1.0) * sparkle * uStars * 2.2;
    float extinction = density*0.24+absorption*2.6;
    emission += transmission * emissive * ds * 1.10;
    transmission *= exp(-extinction*ds);
  }
  return emission + background*transmission;
}

vec3 planetSurface(vec3 p, vec3 normal, vec3 lightDirection, vec3 ringNormal, float radius) {
  vec3 q = normal;
  q.xz = rotation(uTime*0.10) * q.xz;
  float clouds = fbm(q*8.5 + vec3(0.0,uTime*0.02,0.0));
  float band = 0.5 + 0.5*sin(q.y*uPlanetBands*PI + (clouds-0.5)*4.0);
  float fineBand = 0.5+0.5*sin(q.y*uPlanetBands*PI*2.3 + clouds*2.0);
  float cool = smoothstep(7200.0,15000.0,uTemperature);
  vec3 darkColor = mix(vec3(0.24,0.105,0.051),vec3(0.055,0.14,0.28),cool);
  vec3 lightColor = mix(vec3(0.95,0.68,0.39),vec3(0.38,0.74,0.82),cool);
  vec3 color = mix(darkColor,lightColor,smoothstep(0.18,0.87,band));
  color *= 0.78+clouds*0.48+fineBand*0.08;
  vec3 stormCenter = normalize(vec3(0.60,-0.15,0.80));
  float stormDist = length((q-stormCenter)*vec3(1.0,2.7,1.0));
  float storm = 1.0-smoothstep(0.10,0.24,stormDist);
  color = mix(color,mix(vec3(0.70,0.21,0.08),vec3(0.17,0.55,0.62),cool),storm*0.8);
  float diffuse = max(0.0,dot(normal,lightDirection));
  float ringShadow = 1.0;
  float denom = dot(lightDirection,ringNormal);
  if (abs(denom)>0.001) {
    float t = -dot(p,ringNormal)/denom;
    float ringR = length(p+lightDirection*t);
    if (t>0.02 && ringR>radius*1.12 && ringR<radius*uRingWidth) ringShadow = 0.42;
  }
  color *= 0.018 + diffuse*ringShadow*1.4;
  // The ambient term is deliberately low, preserving a clear terminator.
  return color;
}

vec3 planet(vec3 ro, vec3 rd) {
  vec3 background = sky(rd);
  float radius = 2.1*uPlanetRadius;
  vec2 hit = sphereInterval(ro,rd,radius);
  float surfaceT = hit.x>0.0 ? hit.x : (hit.y>0.0 ? hit.y : 1e5);
  vec3 lightDirection = normalize(vec3(-0.62,0.72,0.66));
  vec3 ringNormal = normalize(vec3(0.0,cos(radians(uRingTilt)),sin(radians(uRingTilt))));
  vec3 color = background;
  if (surfaceT<1e4) {
    vec3 p = ro+rd*surfaceT;
    vec3 normal = normalize(p);
    color = planetSurface(p,normal,lightDirection,ringNormal,radius);
    float rim = pow(1.0-max(0.0,dot(normal,-rd)),4.0);
    color += vec3(0.12,0.38,0.70)*rim*max(0.0,dot(normal,lightDirection))*0.30;
  } else {
    float closestT = max(0.0,-dot(ro,rd));
    float altitude = length(ro+rd*closestT)-radius;
    color += vec3(0.065,0.20,0.34)*exp(-max(0.0,altitude)/(radius*0.024))*0.45;
  }
  float denom = dot(rd,ringNormal);
  if (abs(denom)>0.0001) {
    float ringT = -dot(ro,ringNormal)/denom;
    vec3 p = ro+rd*ringT;
    float r = length(p)/radius;
    float outer = max(1.2,uRingWidth);
    if (ringT>0.0 && ringT<surfaceT && r>1.12 && r<outer) {
      float rings = 0.5+0.5*sin(r*130.0+noise3(p*9.0)*4.0);
      float broad = 0.5+0.5*sin(r*24.0);
      float gaps = 1.0-smoothstep(0.015,0.028,abs(r-(1.12+(outer-1.12)*0.55)));
      float mask = smoothstep(1.12,1.16,r)*(1.0-smoothstep(outer-0.04,outer,r));
      float opacity = mask*(0.40+rings*0.26+broad*0.15)*(1.0-gaps*0.90);
      vec2 shadow = sphereInterval(p+lightDirection*0.025,lightDirection,radius);
      float illumination = shadow.x>0.0 ? 0.06 : 0.32+abs(dot(ringNormal,lightDirection))*0.70;
      float cool = smoothstep(7200.0,15000.0,uTemperature);
      vec3 ringColor = mix(vec3(0.74,0.59,0.39),vec3(0.34,0.57,0.69),cool);
      ringColor *= (0.7+broad*0.35+rings*0.13)*illumination;
      color = mix(color,ringColor,opacity);
    }
  }
  return color;
}

vec3 stellar(vec3 ro, vec3 rd) {
  vec3 background = sky(rd);
  const float radius = 2.7;
  vec2 hit = sphereInterval(ro,rd,radius);
  // An artistic warm-to-blue grade keeps convection legible after HDR mapping.
  vec3 grade = mix(vec3(1.0,0.65,0.30), vec3(0.60,0.82,1.0),
                  smoothstep(8000.0,15000.0,uTemperature));
  vec3 heat = blackbody(uTemperature)*grade;
  if (hit.x>0.0) {
    vec3 normal = normalize(ro+rd*hit.x);
    vec3 q = normal;
    q.xz = rotation(uTime*0.060) * q.xz;
    float cells = noise3(q*66.0 + uTime*0.12);
    float granulation = 0.18+pow(cells,1.4)*1.25;
    float convection = fbm(q*8.0+vec3(uTime*0.025,0.0,-uTime*0.014));
    float spots = min(0.85, smoothstep(0.54,0.72,convection)*uStarActivity*0.65);
    float viewCos = max(0.0,dot(normal,-rd));
    float limb = 0.30+0.70*pow(viewCos,0.45);
    vec3 color = heat*granulation*(1.0-spots)*limb*1.6;
    color += vec3(1.0,0.12,0.02)*pow(smoothstep(0.54,0.80,convection),5.0)*uStarActivity*0.16;
    return color;
  }
  float closestT = max(0.0,-dot(ro,rd));
  vec3 nearest = ro+rd*closestT;
  float impact = length(nearest);
  float altitude = max(0.0,impact-radius);
  vec3 direction = nearest/max(impact,0.001);
  direction.xz = rotation(uTime*0.06)*direction.xz;
  float plumes = fbm(direction*12.0 + vec3(uTime*0.03,0.0,-uTime*0.015));
  float rays = pow(plumes,2.0)*1.8;
  float extension = uStarCorona*(0.24+uStarActivity*0.22+rays*0.50);
  float halo = exp(-altitude/max(0.1,extension));
  float prominences = pow(max(0.0,plumes-0.35)*2.3,3.0)*exp(-altitude/(extension*0.8));
  float rim = exp(-altitude/0.065);
  vec3 coronaColor = mix(heat,vec3(1.0,0.19,0.035),0.30);
  vec3 glow = coronaColor*(halo*(0.15+rays*0.48)+prominences*uStarActivity*0.8+rim*0.65);
  return background+glow;
}

void main() {
  vec2 screen = (vUv*2.0-1.0)*vec2(uResolution.x/uResolution.y,1.0);
  float polar = radians(clamp(uInclination,0.5,179.5));
  float distanceScale = uScene>=3 ? 0.72 : 1.0;
  vec3 camera = vec3(sin(polar)*sin(uYaw),cos(polar),sin(polar)*cos(uYaw))*uDistance*distanceScale;
  vec3 forward = normalize(-camera);
  vec3 right = normalize(cross(forward,vec3(0.0,1.0,0.0)));
  vec3 up = cross(right,forward);
  vec3 ray = normalize(forward+0.53*(screen.x*right+screen.y*up));
  vec3 radiance;
  if (uScene==1) radiance = nebula(camera,ray);
  else if (uScene==2) radiance = galaxy(camera,ray);
  else if (uScene==3) radiance = planet(camera,ray);
  else radiance = stellar(camera,ray);
  outColor = vec4(max(vec3(0.0),radiance),1.0);
}`;
