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
export const validate = validate275;
export default validate275;
const schema296 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"GenerationServiceInput","description":"No model, text payload, destination, consent, lease or budget can be supplied.\nThe real Host derives input from the original plan and checks current scope.","type":"object","properties":{"attemptId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"taskId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"unitIds":{"type":"array","items":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"maxItems":100,"minItems":1,"uniqueItems":true}},"additionalProperties":false,"required":["taskId","attemptId","unitIds"]};
const pattern4 = new RegExp("^[A-Za-z0-9.\\-_:/]{1,128}$", "u");

function validate275(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate275.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.taskId === undefined) && (missing0 = "taskId")) || ((data.attemptId === undefined) && (missing0 = "attemptId"))) || ((data.unitIds === undefined) && (missing0 = "unitIds"))){
validate275.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "attemptId") || (key0 === "taskId")) || (key0 === "unitIds"))){
validate275.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.attemptId !== undefined){
let data0 = data.attemptId;
const _errs2 = errors;
if(errors === _errs2){
if(typeof data0 === "string"){
if(!pattern4.test(data0)){
validate275.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate275.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.taskId !== undefined){
let data1 = data.taskId;
const _errs4 = errors;
if(errors === _errs4){
if(typeof data1 === "string"){
if(!pattern4.test(data1)){
validate275.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate275.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.unitIds !== undefined){
let data2 = data.unitIds;
const _errs6 = errors;
if(errors === _errs6){
if(Array.isArray(data2)){
if(data2.length > 100){
validate275.errors = [{instancePath:instancePath+"/unitIds",schemaPath:"#/properties/unitIds/maxItems",keyword:"maxItems",params:{limit: 100},message:"must NOT have more than 100 items"}];
return false;
}
else {
if(data2.length < 1){
validate275.errors = [{instancePath:instancePath+"/unitIds",schemaPath:"#/properties/unitIds/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"}];
return false;
}
else {
var valid1 = true;
const len0 = data2.length;
for(let i0=0; i0<len0; i0++){
let data3 = data2[i0];
const _errs8 = errors;
if(errors === _errs8){
if(typeof data3 === "string"){
if(!pattern4.test(data3)){
validate275.errors = [{instancePath:instancePath+"/unitIds/" + i0,schemaPath:"#/properties/unitIds/items/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate275.errors = [{instancePath:instancePath+"/unitIds/" + i0,schemaPath:"#/properties/unitIds/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid1 = _errs8 === errors;
if(!valid1){
break;
}
}
if(valid1){
let i1 = data2.length;
let j0;
if(i1 > 1){
const indices0 = {};
for(;i1--;){
let item0 = data2[i1];
if(typeof item0 !== "string"){
continue;
}
if(typeof indices0[item0] == "number"){
j0 = indices0[item0];
validate275.errors = [{instancePath:instancePath+"/unitIds",schemaPath:"#/properties/unitIds/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0},message:"must NOT have duplicate items (items ## "+j0+" and "+i1+" are identical)"}];
return false;
break;
}
indices0[item0] = i1;
}
}
}
}
}
}
else {
validate275.errors = [{instancePath:instancePath+"/unitIds",schemaPath:"#/properties/unitIds/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs6 === errors;
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
validate275.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate275.errors = vErrors;
return errors === 0;
}
validate275.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
