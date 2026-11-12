#version 140

in mediump vec3 var_color;
in highp vec3 var_world;

out vec4 out_fragColor;

uniform fs_uniforms
{
    mediump vec4 fog_color;
    mediump vec4 grade;      // rgb tint, a saturation
    highp vec4 fog_params;   // x start, y 1/depth
    highp vec4 cam_pos;
};

void main()
{
    // Fog by the pixel: by the vertex it would smear across the huge faces of the open sea.
    mediump float fog = clamp((distance(var_world, cam_pos.xyz) - fog_params.x) * fog_params.y, 0.0, 1.0);
    mediump vec3 c = mix(var_color, fog_color.rgb, fog);
    mediump float luma = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(luma), c, grade.a) * grade.rgb;
    out_fragColor = vec4(c, 1.0);
}
