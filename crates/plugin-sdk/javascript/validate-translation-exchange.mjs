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
export const validate = validate158;
export default validate158;
const schema176 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TranslationExchange","description":"Complete captured file evidence is retained once, including an empty file.\nDeclared language is domain evidence, not an inferred project locale.","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedTextArtifact"}},"declaredLanguage":{"type":"string"},"entries":{"type":"array","items":{"$ref":"#/$defs/ImportedTranslation"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"order":{"type":"array","items":{"type":"string"}},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","declaredLanguage","languageEvidence","nativeScope","artifacts","entries","order"],"$defs":{"CapturedTextArtifact":{"description":"Captured UTF-8 bytes, including a BOM and original line endings. These are\nimmutable source evidence; logical paths are not local filesystem authority.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"ImportedTranslation":{"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"$ref":"#/$defs/NativeIdentityEvidence"},"source":{"$ref":"#/$defs/SourceReference"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","text","source","nativeIdentity"]},"NativeIdentityDisplay":{"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]},"NativeIdentityEvidence":{"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]},"SourceReference":{"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["artifactId","range"]},"TextEncoding":{"type":"string","enum":["utf8-byte","utf16","grapheme"]},"TextRange":{"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]},"TranslationLanguageEvidence":{"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]},"TranslationNativeScope":{"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]}}};
const schema177 = {"description":"Captured UTF-8 bytes, including a BOM and original line endings. These are\nimmutable source evidence; logical paths are not local filesystem authority.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]};
const schema185 = {"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]};
const schema184 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const func1 = Object.prototype.hasOwnProperty;
const schema178 = {"type":"object","properties":{"id":{"type":"string"},"nativeIdentity":{"$ref":"#/$defs/NativeIdentityEvidence"},"source":{"$ref":"#/$defs/SourceReference"},"text":{"type":"string"}},"additionalProperties":false,"required":["id","text","source","nativeIdentity"]};
const schema179 = {"type":"object","properties":{"display":{"$ref":"#/$defs/NativeIdentityDisplay"},"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"},"value":{"description":"The domain's canonical matching value, not necessarily its original\nliteral spelling. Core does not normalize this value again.","type":"string"}},"additionalProperties":false,"required":["namespace","value","policy","display"]};
const schema180 = {"description":"Domain-confirmed spelling for presentation, separate from canonical\nmatching. A source reference is optional when the identity is derived.","type":"object","properties":{"source":{"anyOf":[{"$ref":"#/$defs/SourceReference"},{"type":"null"}]},"value":{"type":"string"}},"additionalProperties":false,"required":["value","source"]};
const schema181 = {"type":"object","properties":{"artifactId":{"type":"string"},"range":{"$ref":"#/$defs/TextRange"}},"additionalProperties":false,"required":["artifactId","range"]};
const schema182 = {"description":"Half-open offsets into one exact string, never between different strings.","type":"object","properties":{"encoding":{"$ref":"#/$defs/TextEncoding"},"end":{"type":"integer","maximum":4294967295,"minimum":0},"start":{"type":"integer","maximum":4294967295,"minimum":0}},"additionalProperties":false,"required":["encoding","start","end"]};
const schema183 = {"type":"string","enum":["utf8-byte","utf16","grapheme"]};

function validate163(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate163.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.encoding === undefined) && (missing0 = "encoding")) || ((data.start === undefined) && (missing0 = "start"))) || ((data.end === undefined) && (missing0 = "end"))){
validate163.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "encoding") || (key0 === "end")) || (key0 === "start"))){
validate163.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.encoding !== undefined){
let data0 = data.encoding;
const _errs2 = errors;
if(typeof data0 !== "string"){
validate163.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(((data0 === "utf8-byte") || (data0 === "utf16")) || (data0 === "grapheme"))){
validate163.errors = [{instancePath:instancePath+"/encoding",schemaPath:"#/$defs/TextEncoding/enum",keyword:"enum",params:{allowedValues: schema183.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.end !== undefined){
let data1 = data.end;
const _errs5 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate163.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs5){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate163.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 0 || isNaN(data1)){
validate163.errors = [{instancePath:instancePath+"/end",schemaPath:"#/properties/end/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.start !== undefined){
let data2 = data.start;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate163.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate163.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 0 || isNaN(data2)){
validate163.errors = [{instancePath:instancePath+"/start",schemaPath:"#/properties/start/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0},message:"must be >= 0"}];
return false;
}
}
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
else {
validate163.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate163.errors = vErrors;
return errors === 0;
}
validate163.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate162(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate162.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.artifactId === undefined) && (missing0 = "artifactId")) || ((data.range === undefined) && (missing0 = "range"))){
validate162.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "artifactId") || (key0 === "range"))){
validate162.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifactId !== undefined){
const _errs2 = errors;
if(typeof data.artifactId !== "string"){
validate162.errors = [{instancePath:instancePath+"/artifactId",schemaPath:"#/properties/artifactId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.range !== undefined){
const _errs4 = errors;
if(!(validate163(data.range, {instancePath:instancePath+"/range",parentData:data,parentDataProperty:"range",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate163.errors : vErrors.concat(validate163.errors);
errors = vErrors.length;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate162.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate162.errors = vErrors;
return errors === 0;
}
validate162.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate161(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate161.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.value === undefined) && (missing0 = "value")) || ((data.source === undefined) && (missing0 = "source"))){
validate161.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "source") || (key0 === "value"))){
validate161.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.source !== undefined){
let data0 = data.source;
const _errs2 = errors;
const _errs3 = errors;
let valid1 = false;
const _errs4 = errors;
if(!(validate162(data0, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate162.errors : vErrors.concat(validate162.errors);
errors = vErrors.length;
}
var _valid0 = _errs4 === errors;
valid1 = valid1 || _valid0;
const _errs5 = errors;
if(data0 !== null){
const err0 = {instancePath:instancePath+"/source",schemaPath:"#/properties/source/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
var _valid0 = _errs5 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err1 = {instancePath:instancePath+"/source",schemaPath:"#/properties/source/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
validate161.errors = vErrors;
return false;
}
else {
errors = _errs3;
if(vErrors !== null){
if(_errs3){
vErrors.length = _errs3;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.value !== undefined){
const _errs7 = errors;
if(typeof data.value !== "string"){
validate161.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
else {
validate161.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate161.errors = vErrors;
return errors === 0;
}
validate161.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate160(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate160.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.namespace === undefined) && (missing0 = "namespace")) || ((data.value === undefined) && (missing0 = "value"))) || ((data.policy === undefined) && (missing0 = "policy"))) || ((data.display === undefined) && (missing0 = "display"))){
validate160.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "display") || (key0 === "namespace")) || (key0 === "policy")) || (key0 === "value"))){
validate160.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.display !== undefined){
const _errs2 = errors;
if(!(validate161(data.display, {instancePath:instancePath+"/display",parentData:data,parentDataProperty:"display",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate161.errors : vErrors.concat(validate161.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.namespace !== undefined){
const _errs3 = errors;
if(typeof data.namespace !== "string"){
validate160.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.policy !== undefined){
let data2 = data.policy;
const _errs5 = errors;
const _errs6 = errors;
if(errors === _errs6){
if(data2 && typeof data2 == "object" && !Array.isArray(data2)){
let missing1;
if((((data2.id === undefined) && (missing1 = "id")) || ((data2.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data2.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate160.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs8 = errors;
for(const key1 in data2){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate160.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs8 === errors){
if(data2.behaviorVersion !== undefined){
let data3 = data2.behaviorVersion;
const _errs9 = errors;
if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){
validate160.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs9){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate160.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate160.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data2.id !== undefined){
const _errs11 = errors;
if(typeof data2.id !== "string"){
validate160.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs11 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data2.schemaVersion !== undefined){
let data5 = data2.schemaVersion;
const _errs13 = errors;
if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){
validate160.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs13){
if((typeof data5 == "number") && (isFinite(data5))){
if(data5 > 4294967295 || isNaN(data5)){
validate160.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data5 < 1 || isNaN(data5)){
validate160.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs13 === errors;
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
validate160.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.value !== undefined){
const _errs15 = errors;
if(typeof data.value !== "string"){
validate160.errors = [{instancePath:instancePath+"/value",schemaPath:"#/properties/value/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs15 === errors;
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
validate160.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate160.errors = vErrors;
return errors === 0;
}
validate160.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate159(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate159.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.id === undefined) && (missing0 = "id")) || ((data.text === undefined) && (missing0 = "text"))) || ((data.source === undefined) && (missing0 = "source"))) || ((data.nativeIdentity === undefined) && (missing0 = "nativeIdentity"))){
validate159.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "id") || (key0 === "nativeIdentity")) || (key0 === "source")) || (key0 === "text"))){
validate159.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.id !== undefined){
const _errs2 = errors;
if(typeof data.id !== "string"){
validate159.errors = [{instancePath:instancePath+"/id",schemaPath:"#/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeIdentity !== undefined){
const _errs4 = errors;
if(!(validate160(data.nativeIdentity, {instancePath:instancePath+"/nativeIdentity",parentData:data,parentDataProperty:"nativeIdentity",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate160.errors : vErrors.concat(validate160.errors);
errors = vErrors.length;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.source !== undefined){
const _errs5 = errors;
if(!(validate162(data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate162.errors : vErrors.concat(validate162.errors);
errors = vErrors.length;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.text !== undefined){
const _errs6 = errors;
if(typeof data.text !== "string"){
validate159.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
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
}
else {
validate159.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate159.errors = vErrors;
return errors === 0;
}
validate159.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema186 = {"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]};

function validate170(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate170.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.namespace === undefined) && (missing0 = "namespace")) || ((data.policy === undefined) && (missing0 = "policy"))){
validate170.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "namespace") || (key0 === "policy"))){
validate170.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.namespace !== undefined){
const _errs2 = errors;
if(typeof data.namespace !== "string"){
validate170.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.policy !== undefined){
let data1 = data.policy;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate170.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate170.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate170.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate170.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate170.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs8 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.id !== undefined){
const _errs10 = errors;
if(typeof data1.id !== "string"){
validate170.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs10 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs12 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate170.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate170.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate170.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs12 === errors;
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
validate170.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate170.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate170.errors = vErrors;
return errors === 0;
}
validate170.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate158(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate158.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((((((((data.profile === undefined) && (missing0 = "profile")) || ((data.importId === undefined) && (missing0 = "importId"))) || ((data.sourceSetId === undefined) && (missing0 = "sourceSetId"))) || ((data.sourceSnapshotId === undefined) && (missing0 = "sourceSnapshotId"))) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.declaredLanguage === undefined) && (missing0 = "declaredLanguage"))) || ((data.languageEvidence === undefined) && (missing0 = "languageEvidence"))) || ((data.nativeScope === undefined) && (missing0 = "nativeScope"))) || ((data.artifacts === undefined) && (missing0 = "artifacts"))) || ((data.entries === undefined) && (missing0 = "entries"))) || ((data.order === undefined) && (missing0 = "order"))){
validate158.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(func1.call(schema176.properties, key0))){
validate158.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.artifacts !== undefined){
let data0 = data.artifacts;
const _errs2 = errors;
if(errors === _errs2){
if(Array.isArray(data0)){
var valid1 = true;
const len0 = data0.length;
for(let i0=0; i0<len0; i0++){
let data1 = data0[i0];
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((((data1.id === undefined) && (missing1 = "id")) || ((data1.logicalPath === undefined) && (missing1 = "logicalPath"))) || ((data1.role === undefined) && (missing1 = "role"))) || ((data1.sha256 === undefined) && (missing1 = "sha256"))) || ((data1.utf8 === undefined) && (missing1 = "utf8"))){
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((((key1 === "id") || (key1 === "logicalPath")) || (key1 === "role")) || (key1 === "sha256")) || (key1 === "utf8"))){
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.id !== undefined){
const _errs8 = errors;
if(typeof data1.id !== "string"){
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/id",schemaPath:"#/$defs/CapturedTextArtifact/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs8 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.logicalPath !== undefined){
const _errs10 = errors;
if(typeof data1.logicalPath !== "string"){
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/logicalPath",schemaPath:"#/$defs/CapturedTextArtifact/properties/logicalPath/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs10 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.role !== undefined){
const _errs12 = errors;
if(typeof data1.role !== "string"){
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/role",schemaPath:"#/$defs/CapturedTextArtifact/properties/role/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.sha256 !== undefined){
const _errs14 = errors;
if(typeof data1.sha256 !== "string"){
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/sha256",schemaPath:"#/$defs/CapturedTextArtifact/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.utf8 !== undefined){
const _errs16 = errors;
if(typeof data1.utf8 !== "string"){
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0+"/utf8",schemaPath:"#/$defs/CapturedTextArtifact/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid3 = _errs16 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
}
}
else {
validate158.errors = [{instancePath:instancePath+"/artifacts/" + i0,schemaPath:"#/$defs/CapturedTextArtifact/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate158.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.declaredLanguage !== undefined){
const _errs18 = errors;
if(typeof data.declaredLanguage !== "string"){
validate158.errors = [{instancePath:instancePath+"/declaredLanguage",schemaPath:"#/properties/declaredLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs18 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.entries !== undefined){
let data8 = data.entries;
const _errs20 = errors;
if(errors === _errs20){
if(Array.isArray(data8)){
var valid4 = true;
const len1 = data8.length;
for(let i1=0; i1<len1; i1++){
const _errs22 = errors;
if(!(validate159(data8[i1], {instancePath:instancePath+"/entries/" + i1,parentData:data8,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate159.errors : vErrors.concat(validate159.errors);
errors = vErrors.length;
}
var valid4 = _errs22 === errors;
if(!valid4){
break;
}
}
}
else {
validate158.errors = [{instancePath:instancePath+"/entries",schemaPath:"#/properties/entries/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs20 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.importId !== undefined){
const _errs23 = errors;
if(typeof data.importId !== "string"){
validate158.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/properties/importId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs23 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.languageEvidence !== undefined){
let data11 = data.languageEvidence;
const _errs25 = errors;
if(typeof data11 !== "string"){
validate158.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(data11 === "user-confirmed")){
validate158.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/enum",keyword:"enum",params:{allowedValues: schema185.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs25 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeScope !== undefined){
const _errs28 = errors;
if(!(validate170(data.nativeScope, {instancePath:instancePath+"/nativeScope",parentData:data,parentDataProperty:"nativeScope",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate170.errors : vErrors.concat(validate170.errors);
errors = vErrors.length;
}
var valid0 = _errs28 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.order !== undefined){
let data13 = data.order;
const _errs29 = errors;
if(errors === _errs29){
if(Array.isArray(data13)){
var valid6 = true;
const len2 = data13.length;
for(let i2=0; i2<len2; i2++){
const _errs31 = errors;
if(typeof data13[i2] !== "string"){
validate158.errors = [{instancePath:instancePath+"/order/" + i2,schemaPath:"#/properties/order/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid6 = _errs31 === errors;
if(!valid6){
break;
}
}
}
else {
validate158.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs29 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data15 = data.profile;
const _errs33 = errors;
const _errs34 = errors;
if(errors === _errs34){
if(data15 && typeof data15 == "object" && !Array.isArray(data15)){
let missing2;
if((((data15.id === undefined) && (missing2 = "id")) || ((data15.schemaVersion === undefined) && (missing2 = "schemaVersion"))) || ((data15.behaviorVersion === undefined) && (missing2 = "behaviorVersion"))){
validate158.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs36 = errors;
for(const key2 in data15){
if(!(((key2 === "behaviorVersion") || (key2 === "id")) || (key2 === "schemaVersion"))){
validate158.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs36 === errors){
if(data15.behaviorVersion !== undefined){
let data16 = data15.behaviorVersion;
const _errs37 = errors;
if(!(((typeof data16 == "number") && (!(data16 % 1) && !isNaN(data16))) && (isFinite(data16)))){
validate158.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs37){
if((typeof data16 == "number") && (isFinite(data16))){
if(data16 > 4294967295 || isNaN(data16)){
validate158.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data16 < 1 || isNaN(data16)){
validate158.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid8 = _errs37 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data15.id !== undefined){
const _errs39 = errors;
if(typeof data15.id !== "string"){
validate158.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid8 = _errs39 === errors;
}
else {
var valid8 = true;
}
if(valid8){
if(data15.schemaVersion !== undefined){
let data18 = data15.schemaVersion;
const _errs41 = errors;
if(!(((typeof data18 == "number") && (!(data18 % 1) && !isNaN(data18))) && (isFinite(data18)))){
validate158.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs41){
if((typeof data18 == "number") && (isFinite(data18))){
if(data18 > 4294967295 || isNaN(data18)){
validate158.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data18 < 1 || isNaN(data18)){
validate158.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid8 = _errs41 === errors;
}
else {
var valid8 = true;
}
}
}
}
}
}
else {
validate158.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs33 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs43 = errors;
if(typeof data.sourceSetId !== "string"){
validate158.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs43 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSnapshotId !== undefined){
const _errs45 = errors;
if(typeof data.sourceSnapshotId !== "string"){
validate158.errors = [{instancePath:instancePath+"/sourceSnapshotId",schemaPath:"#/properties/sourceSnapshotId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs45 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs47 = errors;
if(typeof data.targetLanguage !== "string"){
validate158.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs47 === errors;
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
}
}
}
}
}
}
}
else {
validate158.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate158.errors = vErrors;
return errors === 0;
}
validate158.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
