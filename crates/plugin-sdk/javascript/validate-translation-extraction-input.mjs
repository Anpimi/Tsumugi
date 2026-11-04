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
export const validate = validate170;
export default validate170;
const schema184 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TranslationExtractionInput","type":"object","properties":{"artifacts":{"type":"array","items":{"$ref":"#/$defs/CapturedArtifact"}},"importId":{"type":"string"},"languageEvidence":{"$ref":"#/$defs/TranslationLanguageEvidence"},"nativeScope":{"$ref":"#/$defs/TranslationNativeScope"},"profile":{"$ref":"#/$defs/ContractRef"},"sourceSetId":{"type":"string"},"sourceSnapshotId":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","importId","sourceSetId","sourceSnapshotId","targetLanguage","languageEvidence","nativeScope","artifacts"],"$defs":{"CapturedArtifact":{"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]},"CapturedBinaryArtifact":{"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]},"CapturedTextArtifact":{"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"TranslationLanguageEvidence":{"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]},"TranslationNativeScope":{"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]}}};
const schema188 = {"description":"Describes the caller's recorded explicit choice, not an execution/adoption\ngrant. Only the trusted application can establish that consent actually ran.","type":"string","enum":["user-confirmed"]};
const schema190 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const schema185 = {"description":"Exactly one representation. Text retains its original wire shape; mixed,\nnull and unknown fields are rejected by the two closed representations.","anyOf":[{"$ref":"#/$defs/CapturedTextArtifact"},{"$ref":"#/$defs/CapturedBinaryArtifact"}]};
const schema186 = {"description":"Exact UTF-8 bytes, including BOMs and original line endings.","type":"object","properties":{"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"},"utf8":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","utf8"]};
const schema187 = {"description":"Canonical padded RFC 4648 base64 of the original bytes. The digest describes\nthe decoded bytes, never their transport encoding. Decoding is domain-owned.","type":"object","properties":{"base64":{"type":"string"},"id":{"type":"string"},"logicalPath":{"type":"string"},"role":{"type":"string"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["id","logicalPath","role","sha256","base64"]};

function validate171(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate171.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
const _errs1 = errors;
const _errs2 = errors;
if(errors === _errs2){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((((data.id === undefined) && (missing0 = "id")) || ((data.logicalPath === undefined) && (missing0 = "logicalPath"))) || ((data.role === undefined) && (missing0 = "role"))) || ((data.sha256 === undefined) && (missing0 = "sha256"))) || ((data.utf8 === undefined) && (missing0 = "utf8"))){
const err0 = {instancePath,schemaPath:"#/$defs/CapturedTextArtifact/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs4 = errors;
for(const key0 in data){
if(!(((((key0 === "id") || (key0 === "logicalPath")) || (key0 === "role")) || (key0 === "sha256")) || (key0 === "utf8"))){
const err1 = {instancePath,schemaPath:"#/$defs/CapturedTextArtifact/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err1];
}
else {
vErrors.push(err1);
}
errors++;
break;
}
}
if(_errs4 === errors){
if(data.id !== undefined){
const _errs5 = errors;
if(typeof data.id !== "string"){
const err2 = {instancePath:instancePath+"/id",schemaPath:"#/$defs/CapturedTextArtifact/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
var valid2 = _errs5 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.logicalPath !== undefined){
const _errs7 = errors;
if(typeof data.logicalPath !== "string"){
const err3 = {instancePath:instancePath+"/logicalPath",schemaPath:"#/$defs/CapturedTextArtifact/properties/logicalPath/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid2 = _errs7 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.role !== undefined){
const _errs9 = errors;
if(typeof data.role !== "string"){
const err4 = {instancePath:instancePath+"/role",schemaPath:"#/$defs/CapturedTextArtifact/properties/role/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.sha256 !== undefined){
const _errs11 = errors;
if(typeof data.sha256 !== "string"){
const err5 = {instancePath:instancePath+"/sha256",schemaPath:"#/$defs/CapturedTextArtifact/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var valid2 = _errs11 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data.utf8 !== undefined){
const _errs13 = errors;
if(typeof data.utf8 !== "string"){
const err6 = {instancePath:instancePath+"/utf8",schemaPath:"#/$defs/CapturedTextArtifact/properties/utf8/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
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
}
}
else {
const err7 = {instancePath,schemaPath:"#/$defs/CapturedTextArtifact/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
valid0 = valid0 || _valid0;
if(_valid0){
var props0 = true;
}
const _errs15 = errors;
const _errs16 = errors;
if(errors === _errs16){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing1;
if((((((data.id === undefined) && (missing1 = "id")) || ((data.logicalPath === undefined) && (missing1 = "logicalPath"))) || ((data.role === undefined) && (missing1 = "role"))) || ((data.sha256 === undefined) && (missing1 = "sha256"))) || ((data.base64 === undefined) && (missing1 = "base64"))){
const err8 = {instancePath,schemaPath:"#/$defs/CapturedBinaryArtifact/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
else {
const _errs18 = errors;
for(const key1 in data){
if(!(((((key1 === "base64") || (key1 === "id")) || (key1 === "logicalPath")) || (key1 === "role")) || (key1 === "sha256"))){
const err9 = {instancePath,schemaPath:"#/$defs/CapturedBinaryArtifact/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
break;
}
}
if(_errs18 === errors){
if(data.base64 !== undefined){
const _errs19 = errors;
if(typeof data.base64 !== "string"){
const err10 = {instancePath:instancePath+"/base64",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/base64/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.id !== undefined){
const _errs21 = errors;
if(typeof data.id !== "string"){
const err11 = {instancePath:instancePath+"/id",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.logicalPath !== undefined){
const _errs23 = errors;
if(typeof data.logicalPath !== "string"){
const err12 = {instancePath:instancePath+"/logicalPath",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/logicalPath/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
var valid4 = _errs23 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.role !== undefined){
const _errs25 = errors;
if(typeof data.role !== "string"){
const err13 = {instancePath:instancePath+"/role",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/role/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
var valid4 = _errs25 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.sha256 !== undefined){
const _errs27 = errors;
if(typeof data.sha256 !== "string"){
const err14 = {instancePath:instancePath+"/sha256",schemaPath:"#/$defs/CapturedBinaryArtifact/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
var valid4 = _errs27 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
}
}
}
else {
const err15 = {instancePath,schemaPath:"#/$defs/CapturedBinaryArtifact/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
}
var _valid0 = _errs15 === errors;
valid0 = valid0 || _valid0;
if(_valid0){
if(props0 !== true){
props0 = true;
}
}
if(!valid0){
const err16 = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
validate171.errors = vErrors;
return false;
}
else {
errors = _errs0;
if(vErrors !== null){
if(_errs0){
vErrors.length = _errs0;
}
else {
vErrors = null;
}
}
}
validate171.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate171.evaluated = {"dynamicProps":true,"dynamicItems":false};

const schema189 = {"description":"Captured from the current adopted source. The plugin supplies canonical\nnative values under this exact policy; Core must never normalize them again.","type":"object","properties":{"namespace":{"type":"string"},"policy":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["namespace","policy"]};

function validate173(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate173.evaluated;
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
validate173.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "namespace") || (key0 === "policy"))){
validate173.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.namespace !== undefined){
const _errs2 = errors;
if(typeof data.namespace !== "string"){
validate173.errors = [{instancePath:instancePath+"/namespace",schemaPath:"#/properties/namespace/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate173.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate173.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate173.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate173.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate173.errors = [{instancePath:instancePath+"/policy/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate173.errors = [{instancePath:instancePath+"/policy/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate173.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate173.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate173.errors = [{instancePath:instancePath+"/policy/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate173.errors = [{instancePath:instancePath+"/policy",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
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
validate173.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate173.errors = vErrors;
return errors === 0;
}
validate173.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


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
if(((((((((data.profile === undefined) && (missing0 = "profile")) || ((data.importId === undefined) && (missing0 = "importId"))) || ((data.sourceSetId === undefined) && (missing0 = "sourceSetId"))) || ((data.sourceSnapshotId === undefined) && (missing0 = "sourceSnapshotId"))) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.languageEvidence === undefined) && (missing0 = "languageEvidence"))) || ((data.nativeScope === undefined) && (missing0 = "nativeScope"))) || ((data.artifacts === undefined) && (missing0 = "artifacts"))){
validate170.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((((key0 === "artifacts") || (key0 === "importId")) || (key0 === "languageEvidence")) || (key0 === "nativeScope")) || (key0 === "profile")) || (key0 === "sourceSetId")) || (key0 === "sourceSnapshotId")) || (key0 === "targetLanguage"))){
validate170.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
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
const _errs4 = errors;
if(!(validate171(data0[i0], {instancePath:instancePath+"/artifacts/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate171.errors : vErrors.concat(validate171.errors);
errors = vErrors.length;
}
var valid1 = _errs4 === errors;
if(!valid1){
break;
}
}
}
else {
validate170.errors = [{instancePath:instancePath+"/artifacts",schemaPath:"#/properties/artifacts/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.importId !== undefined){
const _errs5 = errors;
if(typeof data.importId !== "string"){
validate170.errors = [{instancePath:instancePath+"/importId",schemaPath:"#/properties/importId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.languageEvidence !== undefined){
let data3 = data.languageEvidence;
const _errs7 = errors;
if(typeof data3 !== "string"){
validate170.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
if(!(data3 === "user-confirmed")){
validate170.errors = [{instancePath:instancePath+"/languageEvidence",schemaPath:"#/$defs/TranslationLanguageEvidence/enum",keyword:"enum",params:{allowedValues: schema188.enum},message:"must be equal to one of the allowed values"}];
return false;
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.nativeScope !== undefined){
const _errs10 = errors;
if(!(validate173(data.nativeScope, {instancePath:instancePath+"/nativeScope",parentData:data,parentDataProperty:"nativeScope",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate173.errors : vErrors.concat(validate173.errors);
errors = vErrors.length;
}
var valid0 = _errs10 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.profile !== undefined){
let data5 = data.profile;
const _errs11 = errors;
const _errs12 = errors;
if(errors === _errs12){
if(data5 && typeof data5 == "object" && !Array.isArray(data5)){
let missing1;
if((((data5.id === undefined) && (missing1 = "id")) || ((data5.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data5.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate170.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs14 = errors;
for(const key1 in data5){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate170.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs14 === errors){
if(data5.behaviorVersion !== undefined){
let data6 = data5.behaviorVersion;
const _errs15 = errors;
if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){
validate170.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs15){
if((typeof data6 == "number") && (isFinite(data6))){
if(data6 > 4294967295 || isNaN(data6)){
validate170.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data6 < 1 || isNaN(data6)){
validate170.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid4 = _errs15 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data5.id !== undefined){
const _errs17 = errors;
if(typeof data5.id !== "string"){
validate170.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs17 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data5.schemaVersion !== undefined){
let data8 = data5.schemaVersion;
const _errs19 = errors;
if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){
validate170.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs19){
if((typeof data8 == "number") && (isFinite(data8))){
if(data8 > 4294967295 || isNaN(data8)){
validate170.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data8 < 1 || isNaN(data8)){
validate170.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
}
else {
validate170.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs11 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSetId !== undefined){
const _errs21 = errors;
if(typeof data.sourceSetId !== "string"){
validate170.errors = [{instancePath:instancePath+"/sourceSetId",schemaPath:"#/properties/sourceSetId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs21 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceSnapshotId !== undefined){
const _errs23 = errors;
if(typeof data.sourceSnapshotId !== "string"){
validate170.errors = [{instancePath:instancePath+"/sourceSnapshotId",schemaPath:"#/properties/sourceSnapshotId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs23 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs25 = errors;
if(typeof data.targetLanguage !== "string"){
validate170.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs25 === errors;
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
else {
validate170.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate170.errors = vErrors;
return errors === 0;
}
validate170.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
