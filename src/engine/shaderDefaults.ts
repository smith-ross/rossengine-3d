// Starter source for new Shader / ScreenShader instances (no three.js dependency, so classes can use it).
export const DEFAULT_SHADER_SOURCE = `// Runs for every pixel of the object this Shader is inside.
// BASE is the colour the object would normally have; TIME counts seconds.
// Attributes on this Shader become uniforms (number, bool, Vector2, Vector3, Color3, image).

vec4 fragment() {
	float pulse = 0.5 + 0.5 * sin(TIME * 3.0);
	vec3 color = mix(BASE.rgb, vec3(0.2, 0.6, 1.0), pulse * 0.5);
	return vec4(shade(color), BASE.a);
}

// Optional: move vertices (POSITION is the local position, before Size scaling).
// vec3 vertex() {
// 	return POSITION + NORMAL * sin(TIME + POSITION.y * 4.0) * 0.05;
// }
`

export const DEFAULT_SHADER_SOURCE_2D = `// Runs for every pixel of the 2D object this Shader is inside.
// BASE is the colour the object would normally have; TIME counts seconds.
// Attributes on this Shader become uniforms (number, bool, Vector2, Vector3, Color3, image).

vec4 fragment() {
	float flash = step(0.5, fract(TIME * 2.0));
	return vec4(mix(BASE.rgb, vec3(1.0), flash * 0.6), BASE.a);
}
`

export const DEFAULT_SCREEN_SHADER_SOURCE = `// Post-processing: runs for every pixel of the screen.
// BASE is the rendered image at UV; sample elsewhere with texture(TEXTURE, uv).

vec4 fragment() {
	// vignette
	float d = distance(UV, vec2(0.5));
	float v = smoothstep(0.8, 0.3, d);
	return vec4(BASE.rgb * mix(0.6, 1.0, v), 1.0);
}
`

