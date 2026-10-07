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
export const validate = validate233;
export default validate233;
const schema249 = {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TextReviewCheckInput","description":"Generic captured text only. The profile selects the text checker, not the\noriginal file format. Mapping to project revisions remains Host-owned.","type":"object","properties":{"profile":{"$ref":"#/$defs/ContractRef"},"requirements":{"type":"array","items":{"$ref":"#/$defs/CheckRequirement"}},"resources":{"type":"array","items":{"$ref":"#/$defs/TextReviewResourcePin"}},"selections":{"type":"array","items":{"$ref":"#/$defs/TextReviewSelection"}},"sourceLanguage":{"type":"string"},"targetLanguage":{"type":"string"}},"additionalProperties":false,"required":["profile","sourceLanguage","targetLanguage","resources","selections","requirements"],"$defs":{"CheckImplementation":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]},"CheckKey":{"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]},"CheckRequirement":{"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]},"ContractRef":{"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]},"NotApplicableBasis":{"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]},"PluginIdentity":{"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]},"ProviderSelectionBinding":{"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]},"TextReviewResourcePin":{"description":"Exact package Resource bytes captured by the Host, never a plugin's mutable\nlookup or a claim that the referenced resource has been adopted by a project.","type":"object","properties":{"contributionId":{"type":"string"},"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["contributionId","schema","sha256"]},"TextReviewSelection":{"type":"object","properties":{"sourceRevisionId":{"type":"string"},"sourceText":{"type":"string"},"translationText":{"type":["string","null"]},"unitId":{"type":"string"}},"additionalProperties":false,"required":["unitId","sourceRevisionId","sourceText"]}}};
const schema250 = {"description":"Schema and behavior are separate exact-match compatibility identities.\nMatching JSON field types or a package SemVer is not behavioral compatibility.","type":"object","properties":{"behaviorVersion":{"type":"integer","maximum":4294967295,"minimum":1},"id":{"type":"string"},"schemaVersion":{"type":"integer","maximum":4294967295,"minimum":1}},"additionalProperties":false,"required":["id","schemaVersion","behaviorVersion"]};
const schema261 = {"type":"object","properties":{"sourceRevisionId":{"type":"string"},"sourceText":{"type":"string"},"translationText":{"type":["string","null"]},"unitId":{"type":"string"}},"additionalProperties":false,"required":["unitId","sourceRevisionId","sourceText"]};
const schema251 = {"type":"object","properties":{"inputDigest":{"type":"string"},"key":{"$ref":"#/$defs/CheckKey"},"mandatory":{"type":"boolean"},"notApplicable":{"anyOf":[{"$ref":"#/$defs/NotApplicableBasis"},{"type":"null"}]},"scopeDigest":{"type":"string"},"targets":{"type":"array","items":{"type":"string"}},"waivable":{"type":"boolean"}},"additionalProperties":false,"required":["key","inputDigest","scopeDigest","targets","mandatory","waivable"]};
const schema258 = {"description":"A trusted capture of an allowed reason and its exact scope basis, not a\nplugin's claim that it is safe to skip a required check.","type":"object","properties":{"basisDigest":{"type":"string"},"code":{"type":"string"}},"additionalProperties":false,"required":["code","basisDigest"]};
const schema252 = {"type":"object","properties":{"implementation":{"$ref":"#/$defs/CheckImplementation"},"rule":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["rule","implementation"]};
const schema253 = {"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"core"},"validator":{"$ref":"#/$defs/ContractRef"}},"additionalProperties":false,"required":["kind","validator"]},{"type":"object","properties":{"kind":{"type":"string","const":"plugin"},"provider":{"$ref":"#/$defs/ProviderSelectionBinding"}},"additionalProperties":false,"required":["kind","provider"]}]};
const schema255 = {"description":"A fixed package/contribution choice, independent of any active instance.\nIts digest is supplied by the trusted package owner; this value neither\nauthenticates those bytes nor grants permission to load or call them.","type":"object","properties":{"componentId":{"type":"string"},"contributionId":{"type":"string"},"packageDigest":{"type":"string"},"plugin":{"$ref":"#/$defs/PluginIdentity"}},"additionalProperties":false,"required":["plugin","componentId","contributionId","packageDigest"]};
const schema256 = {"description":"Claimed package identity; a host must authenticate the actual package source.","type":"object","properties":{"id":{"type":"string"},"publisher":{"type":"string"},"version":{"type":"string"}},"additionalProperties":false,"required":["publisher","id","version"]};

function validate237(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate237.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((data.plugin === undefined) && (missing0 = "plugin")) || ((data.componentId === undefined) && (missing0 = "componentId"))) || ((data.contributionId === undefined) && (missing0 = "contributionId"))) || ((data.packageDigest === undefined) && (missing0 = "packageDigest"))){
validate237.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((key0 === "componentId") || (key0 === "contributionId")) || (key0 === "packageDigest")) || (key0 === "plugin"))){
validate237.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.componentId !== undefined){
const _errs2 = errors;
if(typeof data.componentId !== "string"){
validate237.errors = [{instancePath:instancePath+"/componentId",schemaPath:"#/properties/componentId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.contributionId !== undefined){
const _errs4 = errors;
if(typeof data.contributionId !== "string"){
validate237.errors = [{instancePath:instancePath+"/contributionId",schemaPath:"#/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.packageDigest !== undefined){
const _errs6 = errors;
if(typeof data.packageDigest !== "string"){
validate237.errors = [{instancePath:instancePath+"/packageDigest",schemaPath:"#/properties/packageDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs6 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.plugin !== undefined){
let data3 = data.plugin;
const _errs8 = errors;
const _errs9 = errors;
if(errors === _errs9){
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
let missing1;
if((((data3.publisher === undefined) && (missing1 = "publisher")) || ((data3.id === undefined) && (missing1 = "id"))) || ((data3.version === undefined) && (missing1 = "version"))){
validate237.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs11 = errors;
for(const key1 in data3){
if(!(((key1 === "id") || (key1 === "publisher")) || (key1 === "version"))){
validate237.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs11 === errors){
if(data3.id !== undefined){
const _errs12 = errors;
if(typeof data3.id !== "string"){
validate237.errors = [{instancePath:instancePath+"/plugin/id",schemaPath:"#/$defs/PluginIdentity/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs12 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data3.publisher !== undefined){
const _errs14 = errors;
if(typeof data3.publisher !== "string"){
validate237.errors = [{instancePath:instancePath+"/plugin/publisher",schemaPath:"#/$defs/PluginIdentity/properties/publisher/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs14 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data3.version !== undefined){
const _errs16 = errors;
if(typeof data3.version !== "string"){
validate237.errors = [{instancePath:instancePath+"/plugin/version",schemaPath:"#/$defs/PluginIdentity/properties/version/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs16 === errors;
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
validate237.errors = [{instancePath:instancePath+"/plugin",schemaPath:"#/$defs/PluginIdentity/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs8 === errors;
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
validate237.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate237.errors = vErrors;
return errors === 0;
}
validate237.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate236(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate236.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
const _errs0 = errors;
let valid0 = false;
let passing0 = null;
const _errs1 = errors;
if(errors === _errs1){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.kind === undefined) && (missing0 = "kind")) || ((data.validator === undefined) && (missing0 = "validator"))){
const err0 = {instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs3 = errors;
for(const key0 in data){
if(!((key0 === "kind") || (key0 === "validator"))){
const err1 = {instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"};
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
if(_errs3 === errors){
if(data.kind !== undefined){
let data0 = data.kind;
const _errs4 = errors;
if(typeof data0 !== "string"){
const err2 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
if("core" !== data0){
const err3 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "core"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid1 = _errs4 === errors;
}
else {
var valid1 = true;
}
if(valid1){
if(data.validator !== undefined){
let data1 = data.validator;
const _errs6 = errors;
const _errs7 = errors;
if(errors === _errs7){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
const err4 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
else {
const _errs9 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
const err5 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
break;
}
}
if(_errs9 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs10 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
const err6 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
}
if(errors === _errs10){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
const err7 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err7];
}
else {
vErrors.push(err7);
}
errors++;
}
else {
if(data2 < 1 || isNaN(data2)){
const err8 = {instancePath:instancePath+"/validator/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err8];
}
else {
vErrors.push(err8);
}
errors++;
}
}
}
}
var valid3 = _errs10 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.id !== undefined){
const _errs12 = errors;
if(typeof data1.id !== "string"){
const err9 = {instancePath:instancePath+"/validator/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err9];
}
else {
vErrors.push(err9);
}
errors++;
}
var valid3 = _errs12 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs14 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
const err10 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"};
if(vErrors === null){
vErrors = [err10];
}
else {
vErrors.push(err10);
}
errors++;
}
if(errors === _errs14){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
const err11 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"};
if(vErrors === null){
vErrors = [err11];
}
else {
vErrors.push(err11);
}
errors++;
}
else {
if(data4 < 1 || isNaN(data4)){
const err12 = {instancePath:instancePath+"/validator/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"};
if(vErrors === null){
vErrors = [err12];
}
else {
vErrors.push(err12);
}
errors++;
}
}
}
}
var valid3 = _errs14 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
}
else {
const err13 = {instancePath:instancePath+"/validator",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err13];
}
else {
vErrors.push(err13);
}
errors++;
}
}
var valid1 = _errs6 === errors;
}
else {
var valid1 = true;
}
}
}
}
}
else {
const err14 = {instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err14];
}
else {
vErrors.push(err14);
}
errors++;
}
}
var _valid0 = _errs1 === errors;
if(_valid0){
valid0 = true;
passing0 = 0;
var props0 = true;
}
const _errs16 = errors;
if(errors === _errs16){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing2;
if(((data.kind === undefined) && (missing2 = "kind")) || ((data.provider === undefined) && (missing2 = "provider"))){
const err15 = {instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"};
if(vErrors === null){
vErrors = [err15];
}
else {
vErrors.push(err15);
}
errors++;
}
else {
const _errs18 = errors;
for(const key2 in data){
if(!((key2 === "kind") || (key2 === "provider"))){
const err16 = {instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"};
if(vErrors === null){
vErrors = [err16];
}
else {
vErrors.push(err16);
}
errors++;
break;
}
}
if(_errs18 === errors){
if(data.kind !== undefined){
let data5 = data.kind;
const _errs19 = errors;
if(typeof data5 !== "string"){
const err17 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err17];
}
else {
vErrors.push(err17);
}
errors++;
}
if("plugin" !== data5){
const err18 = {instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "plugin"},message:"must be equal to constant"};
if(vErrors === null){
vErrors = [err18];
}
else {
vErrors.push(err18);
}
errors++;
}
var valid4 = _errs19 === errors;
}
else {
var valid4 = true;
}
if(valid4){
if(data.provider !== undefined){
const _errs21 = errors;
if(!(validate237(data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate237.errors : vErrors.concat(validate237.errors);
errors = vErrors.length;
}
var valid4 = _errs21 === errors;
}
else {
var valid4 = true;
}
}
}
}
}
else {
const err19 = {instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err19];
}
else {
vErrors.push(err19);
}
errors++;
}
}
var _valid0 = _errs16 === errors;
if(_valid0 && valid0){
valid0 = false;
passing0 = [passing0, 1];
}
else {
if(_valid0){
valid0 = true;
passing0 = 1;
if(props0 !== true){
props0 = true;
}
}
}
if(!valid0){
const err20 = {instancePath,schemaPath:"#/oneOf",keyword:"oneOf",params:{passingSchemas: passing0},message:"must match exactly one schema in oneOf"};
if(vErrors === null){
vErrors = [err20];
}
else {
vErrors.push(err20);
}
errors++;
validate236.errors = vErrors;
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
validate236.errors = vErrors;
evaluated0.props = props0;
return errors === 0;
}
validate236.evaluated = {"dynamicProps":true,"dynamicItems":false};


function validate235(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate235.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((data.rule === undefined) && (missing0 = "rule")) || ((data.implementation === undefined) && (missing0 = "implementation"))){
validate235.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((key0 === "implementation") || (key0 === "rule"))){
validate235.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.implementation !== undefined){
const _errs2 = errors;
if(!(validate236(data.implementation, {instancePath:instancePath+"/implementation",parentData:data,parentDataProperty:"implementation",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate236.errors : vErrors.concat(validate236.errors);
errors = vErrors.length;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.rule !== undefined){
let data1 = data.rule;
const _errs3 = errors;
const _errs4 = errors;
if(errors === _errs4){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate235.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs6 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate235.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs6 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs7 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate235.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs7){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate235.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate235.errors = [{instancePath:instancePath+"/rule/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs7 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.id !== undefined){
const _errs9 = errors;
if(typeof data1.id !== "string"){
validate235.errors = [{instancePath:instancePath+"/rule/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid2 = _errs9 === errors;
}
else {
var valid2 = true;
}
if(valid2){
if(data1.schemaVersion !== undefined){
let data4 = data1.schemaVersion;
const _errs11 = errors;
if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){
validate235.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs11){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate235.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate235.errors = [{instancePath:instancePath+"/rule/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
return false;
}
}
}
}
var valid2 = _errs11 === errors;
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
validate235.errors = [{instancePath:instancePath+"/rule",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs3 === errors;
}
else {
var valid0 = true;
}
}
}
}
}
else {
validate235.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate235.errors = vErrors;
return errors === 0;
}
validate235.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate234(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate234.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((data.key === undefined) && (missing0 = "key")) || ((data.inputDigest === undefined) && (missing0 = "inputDigest"))) || ((data.scopeDigest === undefined) && (missing0 = "scopeDigest"))) || ((data.targets === undefined) && (missing0 = "targets"))) || ((data.mandatory === undefined) && (missing0 = "mandatory"))) || ((data.waivable === undefined) && (missing0 = "waivable"))){
validate234.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((((((key0 === "inputDigest") || (key0 === "key")) || (key0 === "mandatory")) || (key0 === "notApplicable")) || (key0 === "scopeDigest")) || (key0 === "targets")) || (key0 === "waivable"))){
validate234.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.inputDigest !== undefined){
const _errs2 = errors;
if(typeof data.inputDigest !== "string"){
validate234.errors = [{instancePath:instancePath+"/inputDigest",schemaPath:"#/properties/inputDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.key !== undefined){
const _errs4 = errors;
if(!(validate235(data.key, {instancePath:instancePath+"/key",parentData:data,parentDataProperty:"key",rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate235.errors : vErrors.concat(validate235.errors);
errors = vErrors.length;
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.mandatory !== undefined){
const _errs5 = errors;
if(typeof data.mandatory !== "boolean"){
validate234.errors = [{instancePath:instancePath+"/mandatory",schemaPath:"#/properties/mandatory/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
return false;
}
var valid0 = _errs5 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.notApplicable !== undefined){
let data3 = data.notApplicable;
const _errs7 = errors;
const _errs8 = errors;
let valid1 = false;
const _errs9 = errors;
const _errs10 = errors;
if(errors === _errs10){
if(data3 && typeof data3 == "object" && !Array.isArray(data3)){
let missing1;
if(((data3.code === undefined) && (missing1 = "code")) || ((data3.basisDigest === undefined) && (missing1 = "basisDigest"))){
const err0 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/$defs/NotApplicableBasis/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"};
if(vErrors === null){
vErrors = [err0];
}
else {
vErrors.push(err0);
}
errors++;
}
else {
const _errs12 = errors;
for(const key1 in data3){
if(!((key1 === "basisDigest") || (key1 === "code"))){
const err1 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/$defs/NotApplicableBasis/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"};
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
if(_errs12 === errors){
if(data3.basisDigest !== undefined){
const _errs13 = errors;
if(typeof data3.basisDigest !== "string"){
const err2 = {instancePath:instancePath+"/notApplicable/basisDigest",schemaPath:"#/$defs/NotApplicableBasis/properties/basisDigest/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err2];
}
else {
vErrors.push(err2);
}
errors++;
}
var valid3 = _errs13 === errors;
}
else {
var valid3 = true;
}
if(valid3){
if(data3.code !== undefined){
const _errs15 = errors;
if(typeof data3.code !== "string"){
const err3 = {instancePath:instancePath+"/notApplicable/code",schemaPath:"#/$defs/NotApplicableBasis/properties/code/type",keyword:"type",params:{type: "string"},message:"must be string"};
if(vErrors === null){
vErrors = [err3];
}
else {
vErrors.push(err3);
}
errors++;
}
var valid3 = _errs15 === errors;
}
else {
var valid3 = true;
}
}
}
}
}
else {
const err4 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/$defs/NotApplicableBasis/type",keyword:"type",params:{type: "object"},message:"must be object"};
if(vErrors === null){
vErrors = [err4];
}
else {
vErrors.push(err4);
}
errors++;
}
}
var _valid0 = _errs9 === errors;
valid1 = valid1 || _valid0;
const _errs17 = errors;
if(data3 !== null){
const err5 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/properties/notApplicable/anyOf/1/type",keyword:"type",params:{type: "null"},message:"must be null"};
if(vErrors === null){
vErrors = [err5];
}
else {
vErrors.push(err5);
}
errors++;
}
var _valid0 = _errs17 === errors;
valid1 = valid1 || _valid0;
if(!valid1){
const err6 = {instancePath:instancePath+"/notApplicable",schemaPath:"#/properties/notApplicable/anyOf",keyword:"anyOf",params:{},message:"must match a schema in anyOf"};
if(vErrors === null){
vErrors = [err6];
}
else {
vErrors.push(err6);
}
errors++;
validate234.errors = vErrors;
return false;
}
else {
errors = _errs8;
if(vErrors !== null){
if(_errs8){
vErrors.length = _errs8;
}
else {
vErrors = null;
}
}
}
var valid0 = _errs7 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.scopeDigest !== undefined){
const _errs19 = errors;
if(typeof data.scopeDigest !== "string"){
validate234.errors = [{instancePath:instancePath+"/scopeDigest",schemaPath:"#/properties/scopeDigest/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs19 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targets !== undefined){
let data7 = data.targets;
const _errs21 = errors;
if(errors === _errs21){
if(Array.isArray(data7)){
var valid4 = true;
const len0 = data7.length;
for(let i0=0; i0<len0; i0++){
const _errs23 = errors;
if(typeof data7[i0] !== "string"){
validate234.errors = [{instancePath:instancePath+"/targets/" + i0,schemaPath:"#/properties/targets/items/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid4 = _errs23 === errors;
if(!valid4){
break;
}
}
}
else {
validate234.errors = [{instancePath:instancePath+"/targets",schemaPath:"#/properties/targets/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs21 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.waivable !== undefined){
const _errs25 = errors;
if(typeof data.waivable !== "boolean"){
validate234.errors = [{instancePath:instancePath+"/waivable",schemaPath:"#/properties/waivable/type",keyword:"type",params:{type: "boolean"},message:"must be boolean"}];
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
else {
validate234.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate234.errors = vErrors;
return errors === 0;
}
validate234.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};

const schema259 = {"description":"Exact package Resource bytes captured by the Host, never a plugin's mutable\nlookup or a claim that the referenced resource has been adopted by a project.","type":"object","properties":{"contributionId":{"type":"string"},"schema":{"$ref":"#/$defs/ContractRef"},"sha256":{"type":"string"}},"additionalProperties":false,"required":["contributionId","schema","sha256"]};

function validate242(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate242.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if((((data.contributionId === undefined) && (missing0 = "contributionId")) || ((data.schema === undefined) && (missing0 = "schema"))) || ((data.sha256 === undefined) && (missing0 = "sha256"))){
validate242.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!(((key0 === "contributionId") || (key0 === "schema")) || (key0 === "sha256"))){
validate242.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.contributionId !== undefined){
const _errs2 = errors;
if(typeof data.contributionId !== "string"){
validate242.errors = [{instancePath:instancePath+"/contributionId",schemaPath:"#/properties/contributionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.schema !== undefined){
let data1 = data.schema;
const _errs4 = errors;
const _errs5 = errors;
if(errors === _errs5){
if(data1 && typeof data1 == "object" && !Array.isArray(data1)){
let missing1;
if((((data1.id === undefined) && (missing1 = "id")) || ((data1.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data1.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate242.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs7 = errors;
for(const key1 in data1){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate242.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs7 === errors){
if(data1.behaviorVersion !== undefined){
let data2 = data1.behaviorVersion;
const _errs8 = errors;
if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){
validate242.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs8){
if((typeof data2 == "number") && (isFinite(data2))){
if(data2 > 4294967295 || isNaN(data2)){
validate242.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data2 < 1 || isNaN(data2)){
validate242.errors = [{instancePath:instancePath+"/schema/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate242.errors = [{instancePath:instancePath+"/schema/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate242.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs12){
if((typeof data4 == "number") && (isFinite(data4))){
if(data4 > 4294967295 || isNaN(data4)){
validate242.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data4 < 1 || isNaN(data4)){
validate242.errors = [{instancePath:instancePath+"/schema/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate242.errors = [{instancePath:instancePath+"/schema",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs4 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sha256 !== undefined){
const _errs14 = errors;
if(typeof data.sha256 !== "string"){
validate242.errors = [{instancePath:instancePath+"/sha256",schemaPath:"#/properties/sha256/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate242.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate242.errors = vErrors;
return errors === 0;
}
validate242.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};


function validate233(data, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}={}){
let vErrors = null;
let errors = 0;
const evaluated0 = validate233.evaluated;
if(evaluated0.dynamicProps){
evaluated0.props = undefined;
}
if(evaluated0.dynamicItems){
evaluated0.items = undefined;
}
if(errors === 0){
if(data && typeof data == "object" && !Array.isArray(data)){
let missing0;
if(((((((data.profile === undefined) && (missing0 = "profile")) || ((data.sourceLanguage === undefined) && (missing0 = "sourceLanguage"))) || ((data.targetLanguage === undefined) && (missing0 = "targetLanguage"))) || ((data.resources === undefined) && (missing0 = "resources"))) || ((data.selections === undefined) && (missing0 = "selections"))) || ((data.requirements === undefined) && (missing0 = "requirements"))){
validate233.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0},message:"must have required property '"+missing0+"'"}];
return false;
}
else {
const _errs1 = errors;
for(const key0 in data){
if(!((((((key0 === "profile") || (key0 === "requirements")) || (key0 === "resources")) || (key0 === "selections")) || (key0 === "sourceLanguage")) || (key0 === "targetLanguage"))){
validate233.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs1 === errors){
if(data.profile !== undefined){
let data0 = data.profile;
const _errs2 = errors;
const _errs3 = errors;
if(errors === _errs3){
if(data0 && typeof data0 == "object" && !Array.isArray(data0)){
let missing1;
if((((data0.id === undefined) && (missing1 = "id")) || ((data0.schemaVersion === undefined) && (missing1 = "schemaVersion"))) || ((data0.behaviorVersion === undefined) && (missing1 = "behaviorVersion"))){
validate233.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/required",keyword:"required",params:{missingProperty: missing1},message:"must have required property '"+missing1+"'"}];
return false;
}
else {
const _errs5 = errors;
for(const key1 in data0){
if(!(((key1 === "behaviorVersion") || (key1 === "id")) || (key1 === "schemaVersion"))){
validate233.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs5 === errors){
if(data0.behaviorVersion !== undefined){
let data1 = data0.behaviorVersion;
const _errs6 = errors;
if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){
validate233.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs6){
if((typeof data1 == "number") && (isFinite(data1))){
if(data1 > 4294967295 || isNaN(data1)){
validate233.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data1 < 1 || isNaN(data1)){
validate233.errors = [{instancePath:instancePath+"/profile/behaviorVersion",schemaPath:"#/$defs/ContractRef/properties/behaviorVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate233.errors = [{instancePath:instancePath+"/profile/id",schemaPath:"#/$defs/ContractRef/properties/id/type",keyword:"type",params:{type: "string"},message:"must be string"}];
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
validate233.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/type",keyword:"type",params:{type: "integer"},message:"must be integer"}];
return false;
}
if(errors === _errs10){
if((typeof data3 == "number") && (isFinite(data3))){
if(data3 > 4294967295 || isNaN(data3)){
validate233.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 4294967295},message:"must be <= 4294967295"}];
return false;
}
else {
if(data3 < 1 || isNaN(data3)){
validate233.errors = [{instancePath:instancePath+"/profile/schemaVersion",schemaPath:"#/$defs/ContractRef/properties/schemaVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1},message:"must be >= 1"}];
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
validate233.errors = [{instancePath:instancePath+"/profile",schemaPath:"#/$defs/ContractRef/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid0 = _errs2 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.requirements !== undefined){
let data4 = data.requirements;
const _errs12 = errors;
if(errors === _errs12){
if(Array.isArray(data4)){
var valid3 = true;
const len0 = data4.length;
for(let i0=0; i0<len0; i0++){
const _errs14 = errors;
if(!(validate234(data4[i0], {instancePath:instancePath+"/requirements/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate234.errors : vErrors.concat(validate234.errors);
errors = vErrors.length;
}
var valid3 = _errs14 === errors;
if(!valid3){
break;
}
}
}
else {
validate233.errors = [{instancePath:instancePath+"/requirements",schemaPath:"#/properties/requirements/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs12 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.resources !== undefined){
let data6 = data.resources;
const _errs15 = errors;
if(errors === _errs15){
if(Array.isArray(data6)){
var valid4 = true;
const len1 = data6.length;
for(let i1=0; i1<len1; i1++){
const _errs17 = errors;
if(!(validate242(data6[i1], {instancePath:instancePath+"/resources/" + i1,parentData:data6,parentDataProperty:i1,rootData,dynamicAnchors}))){
vErrors = vErrors === null ? validate242.errors : vErrors.concat(validate242.errors);
errors = vErrors.length;
}
var valid4 = _errs17 === errors;
if(!valid4){
break;
}
}
}
else {
validate233.errors = [{instancePath:instancePath+"/resources",schemaPath:"#/properties/resources/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs15 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.selections !== undefined){
let data8 = data.selections;
const _errs18 = errors;
if(errors === _errs18){
if(Array.isArray(data8)){
var valid5 = true;
const len2 = data8.length;
for(let i2=0; i2<len2; i2++){
let data9 = data8[i2];
const _errs20 = errors;
const _errs21 = errors;
if(errors === _errs21){
if(data9 && typeof data9 == "object" && !Array.isArray(data9)){
let missing2;
if((((data9.unitId === undefined) && (missing2 = "unitId")) || ((data9.sourceRevisionId === undefined) && (missing2 = "sourceRevisionId"))) || ((data9.sourceText === undefined) && (missing2 = "sourceText"))){
validate233.errors = [{instancePath:instancePath+"/selections/" + i2,schemaPath:"#/$defs/TextReviewSelection/required",keyword:"required",params:{missingProperty: missing2},message:"must have required property '"+missing2+"'"}];
return false;
}
else {
const _errs23 = errors;
for(const key2 in data9){
if(!((((key2 === "sourceRevisionId") || (key2 === "sourceText")) || (key2 === "translationText")) || (key2 === "unitId"))){
validate233.errors = [{instancePath:instancePath+"/selections/" + i2,schemaPath:"#/$defs/TextReviewSelection/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2},message:"must NOT have additional properties"}];
return false;
break;
}
}
if(_errs23 === errors){
if(data9.sourceRevisionId !== undefined){
const _errs24 = errors;
if(typeof data9.sourceRevisionId !== "string"){
validate233.errors = [{instancePath:instancePath+"/selections/" + i2+"/sourceRevisionId",schemaPath:"#/$defs/TextReviewSelection/properties/sourceRevisionId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs24 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data9.sourceText !== undefined){
const _errs26 = errors;
if(typeof data9.sourceText !== "string"){
validate233.errors = [{instancePath:instancePath+"/selections/" + i2+"/sourceText",schemaPath:"#/$defs/TextReviewSelection/properties/sourceText/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs26 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data9.translationText !== undefined){
let data12 = data9.translationText;
const _errs28 = errors;
if((typeof data12 !== "string") && (data12 !== null)){
validate233.errors = [{instancePath:instancePath+"/selections/" + i2+"/translationText",schemaPath:"#/$defs/TextReviewSelection/properties/translationText/type",keyword:"type",params:{type: schema261.properties.translationText.type},message:"must be string,null"}];
return false;
}
var valid7 = _errs28 === errors;
}
else {
var valid7 = true;
}
if(valid7){
if(data9.unitId !== undefined){
const _errs30 = errors;
if(typeof data9.unitId !== "string"){
validate233.errors = [{instancePath:instancePath+"/selections/" + i2+"/unitId",schemaPath:"#/$defs/TextReviewSelection/properties/unitId/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid7 = _errs30 === errors;
}
else {
var valid7 = true;
}
}
}
}
}
}
}
else {
validate233.errors = [{instancePath:instancePath+"/selections/" + i2,schemaPath:"#/$defs/TextReviewSelection/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
var valid5 = _errs20 === errors;
if(!valid5){
break;
}
}
}
else {
validate233.errors = [{instancePath:instancePath+"/selections",schemaPath:"#/properties/selections/type",keyword:"type",params:{type: "array"},message:"must be array"}];
return false;
}
}
var valid0 = _errs18 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.sourceLanguage !== undefined){
const _errs32 = errors;
if(typeof data.sourceLanguage !== "string"){
validate233.errors = [{instancePath:instancePath+"/sourceLanguage",schemaPath:"#/properties/sourceLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs32 === errors;
}
else {
var valid0 = true;
}
if(valid0){
if(data.targetLanguage !== undefined){
const _errs34 = errors;
if(typeof data.targetLanguage !== "string"){
validate233.errors = [{instancePath:instancePath+"/targetLanguage",schemaPath:"#/properties/targetLanguage/type",keyword:"type",params:{type: "string"},message:"must be string"}];
return false;
}
var valid0 = _errs34 === errors;
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
else {
validate233.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"},message:"must be object"}];
return false;
}
}
validate233.errors = vErrors;
return errors === 0;
}
validate233.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false};
