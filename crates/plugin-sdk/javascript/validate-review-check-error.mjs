// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.
// Standalone generator: ajv 8.20.0 (MIT).
// The MIT License (MIT)
//
// Copyright (c) 2015-2021 Evgeny Poberezkin
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
"use strict";
export const validate = validate230;
export default validate230;
const schema245 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ReviewCheckError","description":"Public descriptions and operation-local unit references only. Arbitrary\ndiagnostic text is not thereby authenticated or safe to disclose.","type":"object","properties":{"code":{"$ref":"#/$defs/ReviewCheckErrorCode"},"detail":{"type":"string"},"unitId":{"type":["string","null"]}},"additionalProperties":false,"required":["code","detail"],"$defs":{"ReviewCheckErrorCode":{"type":"string","enum":["invalid-input","unsupported-profile","invalid-source","invalid-translation","unsupported-structure","limit-exceeded","cancelled"]}}};
const schema246 = {"type":"string","enum":["invalid-input","unsupported-profile","invalid-source","invalid-translation","unsupported-structure","limit-exceeded","cancelled"]};

function validate230(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate230.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.code === undefined) && (missing0 = "code")) || ((data.detail === undefined) && (missing0 = "detail"))){
validate230.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "code") || (key0 === "detail")) || (key0 === "unitId"))){
validate230.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.code !== undefined){
let data0 = data.code;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate230.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/ReviewCheckErrorCode/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((((((data0 === "invalid-input") || (data0 === "unsupported-profile")) || (data0 === "invalid-source")) || (data0 === "invalid-translation")) || (data0 === "unsupported-structure")) || (data0 === "limit-exceeded")) || (data0 === "cancelled"))){
validate230.errors = [{instancePath:instancePath+"/code",schemaPath:"#/$defs/ReviewCheckErrorCode/enum",keyword:"enum",params:{allowedValues: schema246.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.detail !== undefined){
const _errs5 = errors;
if(typeof data.detail !== "string"){
validate230.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.unitId !== undefined){
let data2 = data.unitId;
const _errs7 = errors;
if((typeof data2 !== "string") && (data2 !== null)){
validate230.errors = [{instancePath:instancePath+"/unitId",schemaPath:"#/properties/unitId/type",keyword:"type",params:{type: schema245.properties.unitId.type},message:"must be string,null"}];
return false;
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
}
else {
validate230.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate230.errors = vErrors;
return errors === 0;
}
validate230.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
