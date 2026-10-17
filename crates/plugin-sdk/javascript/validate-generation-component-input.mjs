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
export const validate = validate291;
export default validate291;
const schema310 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"GenerationComponentInput","description":"Data supplied to the generation component after the Host prepared its\nread-only query inputs from the user's selected work plan.","type":"object","properties":{"generation":{"$ref":"#/$defs/GenerationServiceInput"},"preparedTools":{"type":"array","items":{"$ref":"#/$defs/PreparedToolServiceCall"},"maxItems":15}},"additionalProperties":false,"required":["generation","preparedTools"],"$defs":{"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"EncodedPayload":{"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]},"GenerationServiceInput":{"description":"No model, text payload, destination, consent, lease or budget can be supplied.\nThe real Host derives input from the original plan and checks current scope.","type":"object","properties":{"attemptId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"taskId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"unitIds":{"type":"array","items":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"maxItems":100,"minItems":1,"uniqueItems":true}},"additionalProperties":false,"required":["taskId","attemptId","unitIds"]},"PreparedToolServiceCall":{"description":"One query payload selected from the original work plan. These identities\ncarry data only and do not grant permission to invoke the selected tool.","type":"object","properties":{"callId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"handleId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"input":{"$ref":"#/$defs/EncodedPayload"},"toolHandle":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"}},"additionalProperties":false,"required":["handleId","callId","toolHandle","input"]}}};
const schema311 = {"description":"No model, text payload, destination, consent, lease or budget can be supplied.\nThe real Host derives input from the original plan and checks current scope.","type":"object","properties":{"attemptId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"taskId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"unitIds":{"type":"array","items":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"maxItems":100,"minItems":1,"uniqueItems":true}},"additionalProperties":false,"required":["taskId","attemptId","unitIds"]};
const pattern4 = new RegExp("^[A-Za-z0-9.\\-_:/]{1,128}$", "u");
const schema312 = {"description":"One query payload selected from the original work plan. These identities\ncarry data only and do not grant permission to invoke the selected tool.","type":"object","properties":{"callId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"handleId":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"},"input":{"$ref":"#/$defs/EncodedPayload"},"toolHandle":{"type":"string","pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"}},"additionalProperties":false,"required":["handleId","callId","toolHandle","input"]};
const schema313 = {"description":"Exact UTF-8 schema payload. The SDK verifies its byte digest but does not\nsubstitute a generic parser for that schema's actual semantic validator.","type":"object","properties":{"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["schema","utf8","sha256"]};
const schema314 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};

function validate293(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate293.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.schema === undefined) && (missing0 = "schema")) || ((data.utf8 === undefined) && (missing0 = "utf8"))) || ((data.sha256 === undefined) && (missing0 = "sha256"))){
validate293.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "schema") || (key0 === "sha256")) || (key0 === "utf8"))){
validate293.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.schema !== undefined){
let data0 = data.schema;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate293.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate293.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate293.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate293.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate293.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.id !== undefined){
const _errs8 = errors;
if(typeof data0.id !== "string"){
validate293.errors = [{instancePath:instancePath+"/schema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.schemaVersion !== undefined){
let data3 = data0.schemaVersion;
const _errs10 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate293.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate293.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate293.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate293.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sha256 !== undefined){
const _errs12 = errors;
if(typeof data.sha256 !== "string"){
validate293.errors = [{instancePath:instancePath+"/sha256",schemaPath:"#/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.utf8 !== undefined){
const _errs14 = errors;
if(typeof data.utf8 !== "string"){
validate293.errors = [{instancePath:instancePath+"/utf8",schemaPath:"#/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs14 === errors;
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
validate293.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate293.errors = vErrors;
return errors === 0;
}
validate293.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate292(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate292.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.handleId === undefined) && (missing0 = "handleId")) || ((data.callId === undefined) && (missing0 = "callId"))) || ((data.toolHandle === undefined) && (missing0 = "toolHandle"))) || ((data.input === undefined) && (missing0 = "input"))){
validate292.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "callId") || (key0 === "handleId")) || (key0 === "input")) || (key0 === "toolHandle"))){
validate292.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.callId !== undefined){
let data0 = data.callId;
const _errs2 = errors;
if(errors === _errs2){
if(typeof data0 === "string"){
if(!pattern4.test(data0)){
validate292.errors = [{instancePath:instancePath+"/callId",schemaPath:"#/properties/callId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate292.errors = [{instancePath:instancePath+"/callId",schemaPath:"#/properties/callId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.handleId !== undefined){
let data1 = data.handleId;
const _errs4 = errors;
if(errors === _errs4){
if(typeof data1 === "string"){
if(!pattern4.test(data1)){
validate292.errors = [{instancePath:instancePath+"/handleId",schemaPath:"#/properties/handleId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate292.errors = [{instancePath:instancePath+"/handleId",schemaPath:"#/properties/handleId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.input !== undefined){
const _errs6 = errors;
if(!(validate293(data.input, {instancePath:instancePath+"/input",parentData:data,parentDataProperty:"input",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate293.errors : vErrors.concat(validate293.errors);
errors = vErrors.length;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.toolHandle !== undefined){
let data3 = data.toolHandle;
const _errs7 = errors;
if(errors === _errs7){
if(typeof data3 === "string"){
if(!pattern4.test(data3)){
validate292.errors = [{instancePath:instancePath+"/toolHandle",schemaPath:"#/properties/toolHandle/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate292.errors = [{instancePath:instancePath+"/toolHandle",schemaPath:"#/properties/toolHandle/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
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
}
else {
validate292.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate292.errors = vErrors;
return errors === 0;
}
validate292.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate291(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate291.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.generation === undefined) && (missing0 = "generation")) || ((data.preparedTools === undefined) && (missing0 = "preparedTools"))){
validate291.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "generation") || (key0 === "preparedTools"))){
validate291.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.generation !== undefined){
let data0 = data.generation;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.taskId === undefined) && (missing1 = "taskId")) || ((data0.attemptId === undefined) && (missing1 = "attemptId"))) || ((data0.unitIds === undefined) && (missing1 = "unitIds"))){
validate291.errors = [{instancePath:instancePath+"/generation",schemaPath:"#/$defs/GenerationServiceInput/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "attemptId") || (key1 === "taskId")) || (key1 === "unitIds"))){
validate291.errors = [{instancePath:instancePath+"/generation",schemaPath:"#/$defs/GenerationServiceInput/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.attemptId !== undefined){
let data1 = data0.attemptId;
const _errs6 = errors;
if(errors === _errs6){
if(typeof data1 === "string"){
if(!pattern4.test(data1)){
validate291.errors = [{instancePath:instancePath+"/generation/attemptId",schemaPath:"#/$defs/GenerationServiceInput/properties/attemptId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate291.errors = [{instancePath:instancePath+"/generation/attemptId",schemaPath:"#/$defs/GenerationServiceInput/properties/attemptId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid2 = _errs6 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.taskId !== undefined){
let data2 = data0.taskId;
const _errs8 = errors;
if(errors === _errs8){
if(typeof data2 === "string"){
if(!pattern4.test(data2)){
validate291.errors = [{instancePath:instancePath+"/generation/taskId",schemaPath:"#/$defs/GenerationServiceInput/properties/taskId/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate291.errors = [{instancePath:instancePath+"/generation/taskId",schemaPath:"#/$defs/GenerationServiceInput/properties/taskId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data0.unitIds !== undefined){
let data3 = data0.unitIds;
const _errs10 = errors;
if(errors === _errs10){
if(Array.isArray(data3)){
if(data3.length > 100){
validate291.errors = [{instancePath:instancePath+"/generation/unitIds",schemaPath:"#/$defs/GenerationServiceInput/properties/unitIds/maxItems",keyword:"maxItems",params:{limit: 100},message:"must NOT have more than 100 items"}];
return false;
}
else {
if(data3.length < 1){
validate291.errors = [{instancePath:instancePath+"/generation/unitIds",schemaPath:"#/$defs/GenerationServiceInput/properties/unitIds/minItems",keyword:"minItems",params:{limit: 1},message:"must NOT have fewer than 1 items"}];
return false;
}
else {
var valid3 = true;
const len0 = data3.length;
for(let i0=0; i0<len0; i0++){
let data4 = data3[i0];
const _errs12 = errors;
if(errors === _errs12){
if(typeof data4 === "string"){
if(!pattern4.test(data4)){
validate291.errors = [{instancePath:instancePath+"/generation/unitIds/" + i0,schemaPath:"#/$defs/GenerationServiceInput/properties/unitIds/items/pattern",keyword:"pattern",params:{pattern: "^[A-Za-z0-9.\\-_:/]{1,128}$"},message:"must match pattern \""+"^[A-Za-z0-9.\\-_:/]{1,128}$"+"\""}];
return false;
}
}
else {
validate291.errors = [{instancePath:instancePath+"/generation/unitIds/" + i0,schemaPath:"#/$defs/GenerationServiceInput/properties/unitIds/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
}
var valid3 = _errs12 === errors;
if(!valid3){
break;
}
}
if(valid3){
let i1 = data3.length;
let j0;
if(i1 > 1){
const indices0 = {};
for(;i1--;){
let item0 = data3[i1];
if(typeof item0 !== "string"){
continue;
}
if(typeof indices0[item0] == "number"){
j0 = indices0[item0];
validate291.errors = [{instancePath:instancePath+"/generation/unitIds",schemaPath:"#/$defs/GenerationServiceInput/properties/unitIds/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0},message:"must NOT have duplicate items (items ## "+j0+" and "+i1+" are identical)"}];
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
validate291.errors = [{instancePath:instancePath+"/generation/unitIds",schemaPath:"#/$defs/GenerationServiceInput/properties/unitIds/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
}
}
}
}
}
else {
validate291.errors = [{instancePath:instancePath+"/generation",schemaPath:"#/$defs/GenerationServiceInput/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.preparedTools !== undefined){
let data5 = data.preparedTools;
const _errs14 = errors;
if(errors === _errs14){
if(Array.isArray(data5)){
if(data5.length > 15){
validate291.errors = [{instancePath:instancePath+"/preparedTools",schemaPath:"#/properties/preparedTools/maxItems",keyword:"maxItems",params:{limit: 15},message:"must NOT have more than 15 items"}];
return false;
}
else {
var valid5 = true;
const len1 = data5.length;
for(let i2=0; i2<len1; i2++){
const _errs16 = errors;
if(!(validate292(data5[i2], {instancePath:instancePath+"/preparedTools/" + i2,parentData:data5,parentDataProperty:i2,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate292.errors : vErrors.concat(validate292.errors);
errors = vErrors.length;
}
var valid5 = _errs16 === errors;
if(!valid5){
break;
}
}
}
}
else {
validate291.errors = [{instancePath:instancePath+"/preparedTools",schemaPath:"#/properties/preparedTools/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs14 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate291.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate291.errors = vErrors;
return errors === 0;
}
validate291.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
