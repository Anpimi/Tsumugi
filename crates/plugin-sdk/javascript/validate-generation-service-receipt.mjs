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
export const validate = validate276;
export default validate276;
const schema297 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"GenerationServiceReceipt","description":"The original ledger accepted these identities. A repeated call may already\nbe terminal; this acknowledgement does not claim queue or model completion.\nIt carries no grant, lease, credential or authorization renewal handle.","type":"object","properties":{"attemptId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"inputDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"taskId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"}},"additionalProperties":false,"required":["taskId","attemptId","inputDigest"]};
const pattern4 = new RegExp("^[A-Za-z0-9.\\-_:/]{1,128}$", "u");
const pattern8 = new RegExp("^[a-f0-9]{64}$", "u");

function validate276(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate276.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.taskId === undefined) && (missing0 = "taskId")) || ((data.attemptId === undefined) && (missing0 = "attemptId"))) || ((data.inputDigest === undefined) && (missing0 = "inputDigest"))){
validate276.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "attemptId") || (key0 === "inputDigest")) || (key0 === "taskId"))){
validate276.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
validate276.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate276.errors = [{instancePath:instancePath+"/attemptId",schemaPath:"#/properties/attemptId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.inputDigest !== undefined){
let data1 = data.inputDigest;
const _errs4 = errors;
if(errors === _errs4){
if(typeof data1 === "string"){
if(!pattern8.test(data1)){
validate276.errors = [{instancePath:instancePath+"/inputDigest",schemaPath:"#/properties/inputDigest/pattern",keyword:"pattern",params:{pattern: "^[a-f0-9]{64}$"},message:"must match pattern \""+"^[a-f0-9]{64}$"+"\""}];
return false;
}
}
else {
validate276.errors = [{instancePath:instancePath+"/inputDigest",schemaPath:"#/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.taskId !== undefined){
let data2 = data.taskId;
const _errs6 = errors;
if(errors === _errs6){
if(typeof data2 === "string"){
if(!pattern4.test(data2)){
validate276.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate276.errors = [{instancePath:instancePath+"/taskId",schemaPath:"#/properties/taskId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate276.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate276.errors = vErrors;
return errors === 0;
}
validate276.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
