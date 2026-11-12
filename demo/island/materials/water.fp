#version 140

in mediump vec4 var_color;
in highp vec3 var_world;
in mediump float var_shore;
in highp vec2 var_wave;

out vec4 out_fragColor;

uniform fs_uniforms
{
    mediump vec4 fog_color;
    mediump vec4 grade;
    highp vec4 fog_params;
    highp vec4 cam_pos;
};

void main()
{
    // Foam: a white band at the waterline that breathes in and out.
    mediump float edge = 0.78 + 0.1 * sin(var_wave.y * 1.6 + var_wave.x * 1.9);
    mediump float foam = smoothstep(edge, edge + 0.08, var_shore) * 0.85;
    mediump vec3 c = mix(var_color.rgb, vec3(1.0), foam);
    mediump float a = mix(var_color.a, 0.95, foam);
    mediump float fog = clamp((distance(var_world, cam_pos.xyz) - fog_params.x) * fog_params.y, 0.0, 1.0);
    c = mix(c, fog_color.rgb, fog);
    mediump float luma = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(luma), c, grade.a) * grade.rgb;
    out_fragColor = vec4(c * a, a);
}
